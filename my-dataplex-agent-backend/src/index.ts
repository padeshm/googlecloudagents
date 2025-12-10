#!/usr/bin/env node
import express, { Request, Response } from "express";
import cors from "cors";
import { spawn } from "child_process";
import { Content, VertexAI } from '@google-cloud/vertexai';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// --- Type Definitions ---
interface ChatMessage {
    type: 'user' | 'model';
    content: string;
}

interface RequestBody {
    prompt: string;
    history?: ChatMessage[];
}

// --- Initialize Vertex AI and Express ---
const vertex_ai = new VertexAI({ project: process.env.GOOGLE_CLOUD_PROJECT, location: 'us-central1' });
const model = 'gemini-2.5-flash';

// --- AGENT BRAIN: The Dataplex Expert ---
const generativeModel = vertex_ai.preview.getGenerativeModel({
    model: model,
    systemInstruction: {
        role: 'system',
        parts: [{
            text: `You are a Google Cloud Dataplex expert AI. You have three primary functions: command generation, result summarization, and error interpretation.

**1. Command Generation & Strategy:**
Your main job is to translate the user\'s natural language request into an appropriate, executable command JSON. You must be able to handle multi-turn conversations and proactively find information.

*   **Conversational Context:** Assume follow-up questions relate to the most recently discussed resource. For example, if you just listed scans, and the user says "describe the first one", you must identify the first scan from the previous output and use its ID.

*   **Proactive ID-Finding Strategy:** If a user asks for details about a resource by its display name (e.g., "get details of HANA Data Quality Scan"), you MUST follow this two-step process:
    1.  **Find the ID:** First, generate a \`gcloud dataplex datascans list\` command with a \`--filter\` flag to isolate the specific resource by its display name (e.g., \`--filter="displayName='HANA Data Quality Scan'"\`).
    2.  **Describe the Resource:** Once you have the resource ID from the output of the list command, automatically generate a second command, \`gcloud dataplex datascans describe <ID>\`, to get the details.

*   **Resource ID Integrity:** NEVER invent, guess, or hallucinate a resource ID (e.g., writing \`HANA-Data-Quality-Scan\` when the real ID is \`hana-data-quality-scan\`). If you cannot find the ID using a \`list\` command, inform the user.

*   **Handling Ambiguity:** If you need a location/region and the user hasn't provided one, your entire response MUST be the single string: \`NEEDS_LOCATION\`. Do not guess.

*   **JSON Output Format:** Your final output for a command MUST be a single, valid JSON object enclosed in \`\`\`json markdown fences, containing \`tool\` and \`command\` keys.

**2. Result Summarization:**
When asked to summarize command output, provide a concise, human-friendly summary. DO NOT repeat the raw output.

*   **CRITICAL INSTRUCTION for \`dataplex datascans describe\`:** When summarizing the output of this command, your HIGHEST PRIORITY is to find and explain the data quality rules. You MUST specifically look for the \`dataQualitySpec\` key. If this key exists:
    *   Iterate through the \`rules\` array within it.
    *   For each rule, you MUST explain:
        *   The \`dimension\` (e.g., "COMPLETENESS").
        *   The \`column\` it applies to.
        *   The specific expectation (e.g., \`nonNullExpectation\`).
    *   If \`dataQualitySpec\` or its \`rules\` are missing, you MUST state that no specific data quality rules are defined for the scan.

**3. Error Interpretation:**
When you are asked to interpret an error message, explain it simply. Do not repeat the raw error. If a resource is "not found", suggest checking the ID and location for typos.
`
        }]
    }
});

const app = express();
app.use(cors());
app.use(express.json());

// --- Main API Endpoint ---
app.post("/", async (req: Request, res: Response) => {
    console.log("***** my-dataplex-agent-backend: New request received *****");
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ response: 'Authorization (Access Token) not provided or invalid' });
    }
    const accessToken = authHeader.split(' ')[1];

    const { prompt: userPrompt, history = [] }: RequestBody = req.body;
    if (!userPrompt) {
        return res.status(400).json({ response: 'Prompt not provided' });
    }

    let tool: string;
    let command: string;
    let yamlFilePath: string = '';

    try {
        // --- STEP 1: Generate Command from Prompt ---
        const transformedHistory: Content[] = history.map((msg: ChatMessage) => ({
            role: msg.type === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        })).filter((msg: any) => msg.parts[0].text && msg.role);

        const chat = generativeModel.startChat({ history: transformedHistory });
        const result = await chat.sendMessage(userPrompt);
        const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (!text) {
            return res.status(500).json({ response: "The AI model returned an empty response." });
        }

        // --- Handle 'NEEDS_LOCATION' token ---
        if (text === "NEEDS_LOCATION") {
            return res.json({ response: "I can do that, but I need to know the Google Cloud location/region. Where should I look?" });
        }

        // If the model is asking a clarifying question, just return its response.
        if (!text.includes('{')) {
            return res.json({ response: text });
        }
        
        // --- ROBUST JSON PARSING LOGIC ---
        const startIndex = text.indexOf('{');
        const endIndex = text.lastIndexOf('}');
        if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
            throw new Error("Could not find a valid JSON object in the model's response.");
        }
        const cleanedText = text.substring(startIndex, endIndex + 1);

        const aiResponse = JSON.parse(cleanedText);
        tool = aiResponse.tool;
        command = aiResponse.command;

        // --- STEP 2: Handle YAML for Data Quality Scans ---
        if (aiResponse.yaml_content) {
            const tempDir = os.tmpdir();
            const uniqueId = uuidv4();
            yamlFilePath = path.join(tempDir, `dataplex-scan-${uniqueId}.yaml`);
            await fs.writeFile(yamlFilePath, aiResponse.yaml_content);
            command = command.replace('%%YAML_FILE_PATH%%', yamlFilePath);
            console.log(`[Dataplex Agent] Created temporary YAML spec at: '${yamlFilePath}'`);
        }

        console.log(`[Dataplex Agent] Tool: '${tool}', Command: '${command}'`);

    } catch (error: any) {
        console.error("[Vertex AI] Error during command/YAML generation or parsing:", error);
        return res.status(500).json({ response: `Error processing the AI response: ${error.message}` });
    }

    // --- STEP 3: Execute the Command ---
    const toolPaths: { [key: string]: string } = { 'gcloud': '/usr/bin/gcloud', 'bq': '/usr/bin/bq' };
    const executablePath = toolPaths[tool];
    if (!executablePath) {
        return res.status(400).json({ response: `Unknown tool: ${tool}` });
    }

    const args = command.split(" ");

    const child = spawn(executablePath, args, {
        env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1", CLOUDSDK_AUTH_ACCESS_TOKEN: accessToken },
    });

    let output = "";
    let error = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));
    child.on("error", (err) => {
        console.error(`[SPAWN] System Error: Failed to start command. Error: ${err.message}`);
        res.status(500).json({ response: 'System Error: Failed to start the command process.' });
    });

    child.on("close", async (code) => {
        // --- STEP 4: Clean up ---
        if (yamlFilePath) {
            try {
                await fs.unlink(yamlFilePath);
                console.log(`[Dataplex Agent] Cleaned up temporary YAML file: ${yamlFilePath}`);
            } catch (cleanupError: any) {
                console.error(`[Dataplex Agent] Failed to clean up temporary file: ${yamlFilePath}`, cleanupError.message);
            }
        }

        // --- FINAL STEP: Summarize Success or Failure ---
        try {
            let summaryPrompt: string;
            if (code !== 0) {
                // --- INTELLIGENT ERROR HANDLING ---
                console.error(`[${tool}] Command failed with exit code ${code}:`, error);
                summaryPrompt = `Please provide a concise, human-friendly, natural-language explanation of this error for the user.
                
Original user request: "${userPrompt}"
Error message:
\`\`\`
${error}
\`\`\``;
            } else {
                // --- SUCCESS SUMMARIZATION ---
                console.log(`[${tool}] Command executed successfully.`);
                summaryPrompt = `Please provide a concise, human-friendly, natural-language summary of this output for the user.
                
Original user request: "${userPrompt}"
Command output:
\`\`\`
${output}
\`\`\``;
            }

            const summaryResult = await generativeModel.generateContent(summaryPrompt);
            const summaryText = summaryResult.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            
            // For failures, send a 400 status. For successes, send a 200.
            if (code !== 0) {
                res.status(400).json({ response: summaryText || error });
            } else {
                res.json({ response: summaryText || output });
            }

        } catch (summaryError: any) {
            console.error("[Vertex AI] Error during summarization:", summaryError);
            // Fallback to raw output/error on summary failure
            if (code !== 0) {
                res.status(400).json({ response: error });
            } else {
                res.json({ response: output }); 
            }
        }
    });
});

const PORT = process.env.PORT || 8080;

console.log(`Attempting to start server on port ${PORT}...`);
app.listen(PORT, () => {
  console.log(`Server successfully started and is listening on port ${PORT}`);
  console.log('-> Dataplex Expert REST endpoint available at /');
});
