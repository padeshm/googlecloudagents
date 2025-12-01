#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { Content, VertexAI } from '@google-cloud/vertexai';

// --- Initialize Vertex AI and Express --- 
const vertex_ai = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: 'us-central1' });
const model = 'gemini-2.5-flash';
const generativeModel = vertex_ai.preview.getGenerativeModel({ model: model });

const app = express();
app.use(cors());
app.use(express.json());

// --- Main API Endpoint with CONVERSATIONAL MEMORY ---
app.post("/api/gcloud", async (req, res) => {
    // 1. Authenticate the user (unchanged)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ response: 'Authorization (Access Token) not provided or invalid' });
    }
    const accessToken = authHeader.split(' ')[1];

    // 2. Get the user's newest prompt and the conversation history
    const { prompt: userPrompt, history = [] } = req.body;
    if (!userPrompt) {
        return res.status(400).json({ response: 'Prompt not provided in the request body' });
    }

    // --- STEP 1: Translate prompt to command, using conversation history for context ---
    let gcloudCommand;
    try {
        const commandGenPrompt = {
            // Pass the prior conversation history to the model
            history: history as Content[],
            contents: [{
                role: 'user',
                parts: [{
                    text: `You are an expert in the Google Cloud CLI (gcloud).
                    Your task is to analyze the user's newest request in the context of the prior conversation history and translate it into a single, executable gcloud command.

                    Follow these rules carefully:
                    1.  **Use History:** Use the conversation history to resolve context (e.g., if the user says "what about for that project?", use the project from the history).
                    2.  **Check for Project ID:** If the command you generate absolutely requires a project context AND the user has NOT provided one (either in the new prompt or in the history), you MUST respond with the single keyword: NEEDS_PROJECT
                    3.  **Generate Command:** If a project ID is not needed, or if one is available in the context, translate the request into a gcloud command.
                        - Only output the gcloud command itself.
                        - Do not include the "gcloud" prefix.
                        - If a project context is available, ensure you include the \`--project <project_id>\` flag in your generated command.
                    4.  **Handle Ambiguity:** If the request is ambiguous, too complex, or cannot be translated into a gcloud command even with the history, respond with the single word: ERROR

                    Newest User Request: "${userPrompt}"

                    Resulting Command:`
                }]
            }]
        };

        const result = await generativeModel.generateContent(commandGenPrompt);
        const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (!text) {
            return res.status(500).json({ response: "The AI model returned an invalid response." });
        }

        if (text === "NEEDS_PROJECT") {
            return res.json({ response: "I can do that. For which project would you like me to get this information?" });
        }

        if (text === "ERROR") {
            return res.status(400).json({ response: `I'm sorry, but I couldn't translate that request into a specific gcloud command. Please try rephrasing your request.` });
        }

        gcloudCommand = text;
        console.log(`[Vertex AI] Generated command: 'gcloud ${gcloudCommand}'`);

    } catch (error: any) {
        console.error("[Vertex AI] Error during command generation:", error);
        return res.status(500).json({ response: `Error communicating with the AI model: ${error.message}` });
    }

    // --- STEP 2: Execute the generated gcloud command (unchanged) ---
    const args = gcloudCommand.split(" ");
    const child = spawn("gcloud", args, {
        env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1", CLOUDSDK_AUTH_ACCESS_TOKEN: accessToken },
    });

    let output = "";
    let error = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));
    child.on("error", (err) => res.status(500).json({ response: `System Error: Failed to start gcloud process. Error: ${err.message}` }));

    // --- STEP 3: Summarize the output, using conversation history for context ---
    child.on("close", async (code) => {
        if (code !== 0) {
            return res.status(400).json({ response: `Gcloud Error (Exit Code ${code}):\n${error || `Command: gcloud ${gcloudCommand}`}` });
        }

        try {
            // We create a new history that includes the latest user prompt and the command that was just run.
            const fullHistory = [...history, 
                { role: 'user', parts: [{ text: userPrompt }] },
                // This tells the summarizer what action it just took.
                { role: 'model', parts: [{ text: `Okay, I am running the command: gcloud ${gcloudCommand}` }] },
            ];

            const summarizationPrompt = {
                history: fullHistory,
                contents: [{
                    role: 'user', // The 'user' in this case is the system, providing the gcloud output.
                    parts: [{
                        text: `Here is the output from that command:
                        \`\`\`
                        ${output}
                        \`\`\`
                        Summarize this output in a helpful, conversational way. Do not mention the command you ran.`
                    }]
                }]
            };
            
            const result = await generativeModel.generateContent(summarizationPrompt);
            const summary = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

            if (!summary) {
                return res.json({ response: `> Executed: gcloud ${gcloudCommand}\n\n${output}` });
            }
            res.json({ response: summary });

        } catch (summarizationError: any) {
            console.error("[Vertex AI] Error during summarization:", summarizationError);
            res.status(500).json({ response: `I was able to run the command, but I encountered an error while trying to summarize the results. Here is the raw output:\n\n> Executed: gcloud ${gcloudCommand}\n\n${output}` });
        }
    });
});


// --- MCP Server Logic (This is for the other backend and is unchanged) ---
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { runGcloudCommand } from "./tools/run_gcloud_command.js";
const server = new McpServer({ name: "gcloud-mcp-backend", version: "1.0.0" });
server.tool("run_gcloud_command", runGcloudCommand.parameters, runGcloudCommand.execute);
let transport: SSEServerTransport;
app.get("/sse", async (req, res) => {
    transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
});
app.post("/messages", async (req, res) => {
    if (!transport) return res.status(500).send("Transport not initialized");
    await transport.handlePostMessage(req, res);
});
// --- End of MCP Logic ---


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`-> AgentUI REST endpoint available at /api/gcloud`);
});
