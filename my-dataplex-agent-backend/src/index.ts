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
    // INTERNAL: Used for the two-turn strategy
    _internal_raw_gcloud_output?: string;
}

// --- Initialize Vertex AI and Express ---
const vertex_ai = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: 'us-central1' });
const model = 'gemini-2.5-pro';

// --- AGENT BRAIN: The Dataplex Expert (FINAL) ---
const generativeModel = vertex_ai.preview.getGenerativeModel({
    model: model,
    systemInstruction: {
        role: 'system',
        parts: [{
            text: `You are an expert AI assistant for Google Cloud who translates user requests into executable commands.

**CRITICAL RULES:**

1.  **REMEMBER CONTEXT (PROJECT & LOCATION):** You MUST remember the user's project and location from the conversation history and use them in all subsequent commands. If they have not been provided, your ENTIRE response MUST be the single string: NEEDS_LOCATION or NEEDS_PROJECT.

2.  **TWO-TURN STRATEGY FOR 'describe':** When the user asks for "details", "rules", or to "describe" a resource by name, you MUST use a two-turn process.
    *   **TURN 1: Find the ID.** Your first job is to find the resource's full ID. You MUST generate the JSON for the appropriate "list" command with a "--filter" to find the resource by its name.
    *   **TURN 2: Describe by ID.** The system will execute your "list" command and feed the raw gcloud output back to you. In this second turn, you MUST find the full resource 'NAME' from the raw output (e.g., projects/project-id/locations/loc-id/dataScans/scan-id) and generate the JSON for the "describe" command using that full name. You MUST include the "--view=full" flag for dataplex datascans.

3.  **JSON OUTPUT FORMAT:**
    *   If you are generating a command, your response MUST contain a single, valid JSON object enclosed in \`\`\`json markdown fences. This object must have "tool" and "args" keys.
    *   If you are asking a clarifying question (like for a location), respond in natural language. The system is designed to handle this.
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

    const { prompt: userPrompt, history = [], _internal_raw_gcloud_output }: RequestBody = req.body;
    if (!userPrompt) {
        return res.status(400).json({ response: 'Prompt not provided' });
    }

    // --- STEP 1: Generate Command from Prompt ---
    let aiResponseText: string;
    try {
        const transformedHistory: Content[] = history.map((msg: ChatMessage) => ({
            role: msg.type === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        })).filter((msg: any) => msg.parts[0].text && msg.role);

        // If this is Turn 2 of our strategy, add the raw gcloud output to the history
        let currentPrompt = userPrompt;
        if (_internal_raw_gcloud_output) {
            transformedHistory.push({ role: 'user', parts: [{ text: `RAW GCLOUD OUTPUT TO PARSE:\\n\\\`\\\`\\\`\\n${_internal_raw_gcloud_output}\\n\\\`\\\`\\\`` }] });
            // We reuse the original prompt to keep the context for the AI
        }

        const chat = generativeModel.startChat({ history: transformedHistory });
        const result = await chat.sendMessage(currentPrompt);
        aiResponseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';

        if (!aiResponseText) {
            throw new Error("The AI model returned an empty response.");
        }
        console.log(`[AI_RESPONSE]: ${aiResponseText}`);

    } catch (error: any) {
        console.error("[Vertex AI] Error during command generation:", error);
        return res.status(500).json({ response: `Error processing the AI response: ${error.message}` });
    }
    
    // --- STEP 2: Parse and Execute (or Respond Conversationally) ---
    try {
        // Handle 'NEEDS_LOCATION' or 'NEEDS_PROJECT' tokens
        if (aiResponseText === "NEEDS_LOCATION" || aiResponseText === "NEEDS_PROJECT") {
            const missing = aiResponseText.split('_')[1].toLowerCase();
            return res.json({ response: `I can do that, but I need to know the Google Cloud ${missing}. Where should I look?` });
        }

        const startIndex = aiResponseText.indexOf('{');
        const endIndex = aiResponseText.lastIndexOf('}');

        // If no valid JSON object, it's a conversational response
        if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
            console.log("[CONVERSATIONAL_RESPONSE]: No valid JSON found, treating as a conversational response.");
            return res.json({ response: aiResponseText });
        }
        
        const cleanedText = aiResponseText.substring(startIndex, endIndex + 1);
        const aiResponse = JSON.parse(cleanedText);
        const { tool, args } = aiResponse;

        // --- Execute the command ---
        const toolPaths: { [key: string]: string } = { 'gcloud': '/usr/bin/gcloud', 'gsutil': '/usr/bin/gsutil', 'bq': '/usr/bin/bq' };
        const executablePath = toolPaths[tool];
        if (!executablePath) {
            return res.status(403).json({ response: `The command tool '${tool}' is not in the list of allowed tools.` });
        }

        console.log(`[PARSED_COMMAND]: Tool: '${tool}', Args:`, args);
        const child = spawn(executablePath, args, {
            env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1", CLOUDSDK_AUTH_ACCESS_TOKEN: accessToken },
        });

        let output = "";
        let error = "";
        child.stdout.on("data", (data) => (output += data.toString()));
        child.stderr.on("data", (data) => (error += data.toString()));
        child.on("error", (err) => {
            console.error(`[SPAWN_ERROR]: ${err.message}`);
            return res.status(500).json({ response: 'System Error: Failed to start the command process.' });
        });

        // --- STEP 3: Handle Command Completion ---
        child.on("close", async (code) => {
            console.log(`[COMMAND_STDOUT]: ${output}`);
            console.log(`[COMMAND_STDERR]: ${error}`);
            console.log(`[COMMAND_EXIT_CODE]: ${code}`);

            if (code !== 0) {
                 // Summarize the error and return
                const summaryPrompt = `Please provide a concise, human-friendly, natural-language explanation of this error for the user.\\n\\nOriginal user request: "${userPrompt}"\\nError message:\\n\\\`\\\`\\\`\\n${error}\\n\\\`\\\`\\\``;
                const summaryResult = await generativeModel.generateContent(summaryPrompt);
                const summaryText = summaryResult.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                return res.status(400).json({ response: summaryText || error });
            }

            // --- SMART DISPATCH: Decide whether to summarize or continue the two-turn strategy ---
            const isListCommand = args.includes("list");
            const userWantsDetails = userPrompt.includes("details") || userPrompt.includes("rules") || userPrompt.includes("describe");

            if (isListCommand && userWantsDetails && output.trim()) {
                // This was Turn 1. Let's automatically start Turn 2.
                console.log("[STRATEGY_ENGINE]: Turn 1 complete. Feeding raw output to AI for Turn 2.");
                const nextRequest: RequestBody = {
                    prompt: userPrompt, // Reuse original prompt
                    history: [...history, {type: 'user', content: userPrompt}, {type: 'model', content: aiResponseText}],
                    _internal_raw_gcloud_output: output 
                };
                // Make a recursive call to self to process the next step
                return app._router.handle({ ...req, body: nextRequest }, res);
            }

            // --- Regular Summarization for all other successful commands ---
            let summarizationInstruction = "Please provide a concise, human-friendly, natural-language summary of this output for the user.";
            if (args.includes("dataplex") && args.includes("datascans") && args.includes("describe")) {
                summarizationInstruction += ` Your HIGHEST PRIORITY is to find and explain the data quality rules from the 'dataQualitySpec' key. For each rule, explain the dimension, the column, and the specific expectation.`;
            }
            const summaryPrompt = `${summarizationInstruction}\\n\\nOriginal user request: "${userPrompt}"\\nCommand output:\\n\\\`\\\`\\\`\\n${output}\\n\\\`\\\`\\\``;
            
            const summaryResult = await generativeModel.generateContent(summaryPrompt);
            const summaryText = summaryResult.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            res.json({ response: summaryText || output });

        });

    } catch (error: any) {
        console.error("[EXECUTION_ERROR]:", error);
        res.status(500).json({ response: `An unexpected error occurred: ${error.message}` });
    }
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server successfully started and is listening on port ${PORT}`);
  console.log('-> Dataplex Expert REST endpoint available at /');
});
