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
const vertex_ai = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: 'us-central1' });
const model = 'gemini-2.5-pro';

// --- AGENT BRAIN: The Dataplex Expert ---
const generativeModel = vertex_ai.preview.getGenerativeModel({
    model: model,
    systemInstruction: {
        role: 'system',
        parts: [{
            text: `You are an expert AI assistant for Google Cloud, specializing in Dataplex and its related data resources like BigQuery. Your purpose is to generate commands for both Dataplex (using 'gcloud'), BigQuery (using the 'bq' tool) and Storage (using the 'gsutil' tool).

**Core Dataplex Concepts:**
*   **Data Quality Scans are the Default:** The \`gcloud dataplex datascans\` command group exclusively manages data quality scans. Therefore, you MUST NOT use a \`--type\` or \`--type=DATA_QUALITY\` filter when listing or describing scans. It will always cause an error.
*   **Recognize Synonyms:** The user may refer to data quality scans using various terms. Treat all of the following as synonyms for \`gcloud dataplex datascans\`: "data quality job", "data quality jobs", "data quality scan", "data quality scans", "datascan", "datascans", "jobscans".
*   **List vs. Describe:**
    *   If the user asks to "list", "show", or "find" scans, use the \`gcloud dataplex datascans list\` command.
    *   If the user asks for "details", "rules", "specifications", or information about a *specific* scan (e.g., "describe the scan named 'foo'"), your primary goal is to use the \`gcloud dataplex datascans describe\` command.
    *   **CRITICAL:** When generating a 'describe' command, you **MUST** include the \`--view=full\` flag to retrieve all necessary details for rule analysis. For example: \`gcloud dataplex datascans describe my-scan-id --location=us-central1 --view=full\`.
    *   To get the details, you will often need to first use the \`list\` command with a filter to find the scan's ID, and then immediately issue the \`describe\` command with that ID and the \`--view=full\` flag.

**1. Command Generation & Strategy:**
Your main job is to translate the user's natural language request into an appropriate, executable command JSON. You must be able to handle multi-turn conversations and proactively find information.

*   **Conversational Context:** Assume follow-up questions relate to the most recently discussed resource. For example, if you just listed scans, and the user says "describe the first one", you must identify the first scan from the previous output and use its ID.

*   **Proactive ID-Finding Strategy:** If a user asks for details about a resource by its display name (e.g., "get details of HANA Data Quality Scan"), you MUST follow this two-step process:
    1.  **Find the ID:** First, generate a command to list the resource with a filter to find the specific display name.
    2.  **Describe the Resource:** Once you have the resource ID from the output of the list command, automatically generate a second command to describe that resource by its ID.

*   **Resource ID Integrity:** NEVER invent, guess, or hallucinate a resource ID. If you cannot find the ID using a \`list\` command, inform the user.

*   **Handling Ambiguity:** If you need a location/region and the user has not provided one, your entire response MUST be the single string: \`NEEDS_LOCATION\`.

*   **JSON Output Format:** Your final output for a command MUST be a single, valid JSON object enclosed in \`\`\`json markdown fences. This object must contain a "tool" key (e.g., "gcloud", "bq") and an "args" key, which is an **array of strings** representing the command and its arguments. For example: { "tool": "gcloud", "args": ["dataplex", "datascans", "list", "--filter=displayName='HANA Data Quality Scan'"] }. Each part of the command, including flags and their values, should be elements in the array. If a flag and its value are a single unit (e.g., --filter=VALUE), they should be a single string in the array.

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

**4. Rule Creation (YAML Generation):**
*   The user will eventually want to create new data quality scans and rules.
*   Creating a data quality scan requires generating a YAML file that defines the scan's properties, including its rules.
*   When the user asks to "create a scan" or "add a rule", your goal is to generate the appropriate YAML content and a \`gcloud dataplex datascans create\` or \`gcloud dataplex datascans update\` command that uses the \`--spec-file-path\` argument.
*   You will need to ask clarifying questions to get the necessary details for the YAML file, such as the table to scan, the dimension, the column, and the rule type (e.g., non-null, range, regex).
*   The final JSON output should include a \`yaml_content\` key containing the full YAML as a string, and the \`args\` for the \`gcloud\` command should use a placeholder \`%%YAML_FILE_PATH%%\` for the file path.`
        }]
    }
});

const app = express();
app.use(cors());
app.use(express.json());

// --- Main API Endpoint ---
app.post("/", async (req: Request, res: Response) => {
    console.log("--- NEW DATAPLEX-BACKEND REQUEST ---");
    console.log(`[REQUEST_BODY]: ${JSON.stringify(req.body)}`);

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
    let args: string[];
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

        console.log(`[AI_RESPONSE]: ${text}`);

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
        args = aiResponse.args; // Use the 'args' array directly

        // --- STEP 2: Handle YAML for Data Quality Scans (if needed) ---
        if (aiResponse.yaml_content) {
            const tempDir = os.tmpdir();
            const uniqueId = uuidv4();
            yamlFilePath = path.join(tempDir, `dataplex-scan-${uniqueId}.yaml`);
            await fs.writeFile(yamlFilePath, aiResponse.yaml_content);
            // Find and replace the placeholder in the args array
            const yamlPlaceholderIndex = args.findIndex(arg => arg.includes('%%YAML_FILE_PATH%%'));
            if (yamlPlaceholderIndex > -1) {
                args[yamlPlaceholderIndex] = args[yamlPlaceholderIndex].replace('%%YAML_FILE_PATH%%', yamlFilePath);
            }
            console.log(`[Dataplex Agent] Created temporary YAML spec at: '${yamlFilePath}'`);
        }

        console.log(`[PARSED_COMMAND]: Tool: '${tool}', Args:`, args);

    } catch (error: any) {
        console.error("[Vertex AI] Error during command/YAML generation or parsing:", error);
        return res.status(500).json({ response: `Error processing the AI response: ${error.message}` });
    }

    // --- STEP 3: Execute Command ---
    const toolPaths: { [key: string]: string } = {
        'gcloud': '/usr/bin/gcloud', 'gsutil': '/usr/bin/gsutil', 'bq': '/usr/bin/bq'
    };
    const executablePath = toolPaths[tool];
    if (!executablePath) {
        return res.status(403).json({ response: `The command tool '${tool}' is not in the list of allowed tools.` });
    }

    console.log(`[EXECUTION_ENV]: ${JSON.stringify(process.env)}`);
    const child = spawn(executablePath, args, {
        env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1", CLOUDSDK_AUTH_ACCESS_TOKEN: accessToken },
    });

    let output = "";
    let error = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));
    child.on("error", (err) => {
        console.error(`[SPAWN_ERROR]: ${err.message}`);
        res.status(500).json({ response: 'System Error: Failed to start the command process.' });
    });

    child.on("close", async (code) => {
        console.log(`[COMMAND_STDOUT]: ${output}`);
        console.log(`[COMMAND_STDERR]: ${error}`);
        console.log(`[COMMAND_EXIT_CODE]: ${code}`);

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
                summaryPrompt = `Please provide a concise, human-friendly, natural-language explanation of this error for the user.
                
Original user request: "${userPrompt}"
Error message:
\`\`\`
${error}
\`\`\``;
            } else {
                // --- SUCCESS SUMMARIZATION ---
                summaryPrompt = `Please provide a concise, human-friendly, natural-language summary of this output for the user.
                
Original user request: "${userPrompt}"
Command output:
\`\`\`
${output}
\`\`\``;
            }

            const summaryResult = await generativeModel.generateContent(summaryPrompt);
            const summaryText = summaryResult.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            
            if (code !== 0) {
                res.status(400).json({ response: summaryText || error });
            } else {
                res.json({ response: summaryText || output });
            }

        } catch (summaryError: any) {
            console.error("[Vertex AI] Error during summarization:", summaryError);
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