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

**CRITICAL RULES:**

1.  **YOUR ONLY JOB IS TO GENERATE COMMANDS:** You MUST NOT answer questions or carry on a conversation. Your ENTIRE response MUST be a single JSON object and nothing else. Do not add any conversational text before or after the JSON block.

2.  **ONE COMMAND PER TURN:** You MUST ONLY generate the JSON for a SINGLE command in each turn.

3.  **REMEMBER THE CONTEXT (PROJECT & LOCATION):** The user's project and location/region are critical.
    *   If the project or location is mentioned anywhere in the conversation history, you MUST remember it and use it in all subsequent commands (using --project and --location flags).
    *   You are FORBIDDEN from asking for the project or location if it has already been provided.
    *   If the project or location has NOT been provided, your entire response must be the single string: NEEDS_LOCATION or NEEDS_PROJECT.

4.  **TWO-TURN STRATEGY FOR 'describe':** When the user asks for "details", "rules", or to "describe" a resource by its name (e.g., "details for 'Customer DQ Scan'"):
    *   **TURN 1:** Your ONLY job is to find the resource's ID. You MUST generate the JSON for the appropriate "list" command with a "--filter" to find the resource by its name.
    *   **TURN 2:** The system will execute the "list" command. The resulting ID will be in the history. In this second turn, you MUST generate the JSON for the "describe" command using the ID from the previous turn's output. You MUST include the "--view=full" flag for dataplex datascans.

5.  **JSON OUTPUT FORMAT:**
    *   Your final output MUST be a single, valid JSON object enclosed in \`\`\`json markdown fences.
    *   This object must contain a "tool" key (e.g., "gcloud") and an "args" key, which is an array of strings.
    *   Example: { "tool": "gcloud", "args": ["dataplex", "datascans", "list", "--location=us-central1", "--project=my-project-id", "--filter=displayName='HANA Data Quality Scan'"] }

**SUMMARIZATION CONTEXT (FOR SYSTEM USE, NOT YOURS):**
*   After your command is run, the system will summarize the output. The system will look for 'dataQualitySpec' in 'gcloud dataplex datascans describe' output and explain the rules.
`
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

            // --- Handle 'NEEDS_LOCATION' or 'NEEDS_PROJECT' tokens ---
            if (text === "NEEDS_LOCATION" || text === "NEEDS_PROJECT") {
                const missing = text.split('_')[1].toLowerCase();
                return res.json({ response: `I can do that, but I need to know the Google Cloud ${missing}. Where should I look?` });
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
        
        // --- NEW: Guardrail for empty output ---
        // If there is no output and no error, it means the AI likely returned a conversational response instead of a command.
        if (code === 0 && !output.trim() && !error.trim()) {
            return res.status(400).json({ response: "I'm sorry, I wasn't able to generate a valid command for your request. Please try rephrasing your request to be more specific about the command you'd like to run." });
        }


        // --- FINAL STEP: Summarize Success or Failure ---
        try {
            let summaryPrompt: string;
            if (code !== 0) {
                // --- INTELLIGENT ERROR HANDLING ---
                summaryPrompt = `Please provide a concise, human-friendly, natural-language explanation of this error for the user.\n                \nOriginal user request: "${userPrompt}"\nError message:\n\`\`\`\n${error}\n\`\`\``;
            } else {
                // --- SUCCESS SUMMARIZATION ---
                 let summarizationInstruction = "Please provide a concise, human-friendly, natural-language summary of this output for the user.";
                // Add specific instruction for dataplex datascans describe
                if (args.includes("dataplex") && args.includes("datascans") && args.includes("describe")) {
                    summarizationInstruction += ` Your HIGHEST PRIORITY is to find and explain the data quality rules from the 'dataQualitySpec' key. For each rule, explain the dimension, the column, and the specific expectation.`;
                }
                summaryPrompt = `${summarizationInstruction}\n\nOriginal user request: "${userPrompt}"\nCommand output:\n\`\`\`\n${output}\n\`\`\``;
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