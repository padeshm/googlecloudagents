#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { Content, VertexAI } from '@google-cloud/vertexai';

// --- Initialize Vertex AI and Express --- 
const vertex_ai = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: 'us-central1' });
const model = 'gemini-2.5-flash';

// --- AGENT BRAIN 1: The Command Generator ---
const generativeModel = vertex_ai.preview.getGenerativeModel({ 
    model: model,
    systemInstruction: {
        role: 'system',
        parts: [{
            text: `You are an expert in Google Cloud command-line tools. Your goal is to translate a user's request into an executable command for one of the following tools: gcloud, gsutil, kubectl, bq.\n\nRULES:\n1.  **Choose the Best Tool:** Based on the user's request and the conversation history, determine the most appropriate command-line tool to use from the allowed list: \`gcloud\`, \`gsutil\`, \`kubectl\`, \`bq\`.
2.  **Output JSON:** Your final output MUST be a single, valid JSON object with two keys:
    -   \`tool\`: A string containing the name of the chosen tool (e.g., "gcloud", "kubectl").
    -   \`command\`: A string containing the rest of the command to be executed, without the tool name prefix.
3.  **Use History:** You MUST take into account the user's conversation history to understand the full context. The user's latest message is often the final piece of information needed to complete a command.
4.  **Handle Missing Project:** If a command requires a project ID and one has not been provided in the history or the latest prompt, you MUST return the single keyword: \`NEEDS_PROJECT\`. Do not output JSON in this case.
5.  **Handle Errors:** If the request, even with the full history, is ambiguous, impossible, or cannot be translated into a valid command for any of the allowed tools, you MUST return the single keyword: \`ERROR\`. Do not output JSON in this case.

Example:
User Request: "list my cloud storage buckets for project my-gcp-project"
Your Output:
{
  "tool": "gsutil",
  "command": "ls -p my-gcp-project"
}`
        }]
    }
});

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
    let tool: string;
    let command: string;
    try {
        // --- FIX: Transform client-side history to the Vertex AI SDK format ---
        const transformedHistory = history.map((msg: any) => ({
            role: msg.type === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        })).filter((msg: any) => msg.parts[0].text && msg.role);

        const chat = generativeModel.startChat({ history: transformedHistory as Content[] });
        const result = await chat.sendMessage(userPrompt);
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

        // --- NEW: Parse the JSON response from the AI ---
        const aiResponse = JSON.parse(text);
        tool = aiResponse.tool;
        command = aiResponse.command;
        console.log(`[Vertex AI] Chosen tool: '${tool}', Generated command: '${command}'`);

    } catch (error: any) {
        console.error("[Vertex AI] Error during command generation:", error);
        return res.status(500).json({ response: `Error communicating with the AI model: ${error.message}` });
    }
    
    // --- STEP 2: Execute the generated command with security checks ---
    const ALLOWED_TOOLS = ['gcloud', 'gsutil', 'kubectl', 'bq'];
    if (!ALLOWED_TOOLS.includes(tool)) {
        return res.status(403).json({ response: `The command '${tool}' is not in the list of allowed tools.` });
    }

    const args = command.split(" ");
    const child = spawn(tool, args, {
        env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1", CLOUDSDK_AUTH_ACCESS_TOKEN: accessToken },
    });

    let output = "";
    let error = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));
    child.on("error", (err) => res.status(500).json({ response: `System Error: Failed to start gcloud process. Error: ${err.message}` }));

    // --- STEP 3: Summarize success OR interpret failure ---
    child.on("close", async (code) => {
        if (code !== 0) {
            // --- Handle FAILURE by having the AI interpret the error ---
            console.error(`[${tool}] Command failed with exit code ${code}:`, error);
            try {
                const errorAnalyzerModel = vertex_ai.preview.getGenerativeModel({
                    model: model,
                    systemInstruction: {
                        role: 'system',
                        parts: [{
                            text: `You are a helpful Google Cloud assistant. A command has failed. Your goal is to explain the technical error message to a user in a simple, human-readable way.

RULES:
- DO NOT show the user the raw error message.
- Analyze the error and explain the likely root cause.
- If the error indicates a project was not found, a typo in the project name, or a permissions issue like SERVICE_DISABLED or PERMISSION_DENIED, tell the user to check that their project ID is correct and that they have the necessary permissions.
- If the error mentions enabling an API, explain that a specific service needs to be activated for their project.
- Provide a clear, concise, and friendly explanation of the problem and suggest a solution.`
                        }]
                    }
                });
                const result = await errorAnalyzerModel.generateContent(error);
                const friendlyError = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                return res.status(400).json({ response: friendlyError || `The command failed, and I was unable to determine the cause.` });

            } catch (analysisError: any) {
                console.error("[Vertex AI] Error during error analysis:", analysisError);
                return res.status(500).json({ response: `The command failed, and I was unable to analyze the error. Here is the raw error:\\n\\n${error}` });
            }
        }

        // --- Handle SUCCESS (this part is now for success cases only) ---
        try {
            const summarizerModel = vertex_ai.preview.getGenerativeModel({
                model: model,
                systemInstruction: {
                    role: 'system',
                    parts: [{ text: `You are a helpful Google Cloud assistant. Your goal is to summarize the output of a command in a clear, conversational way. Do not mention the command that was run.` }]
                }
            });

            // --- FIX: Use the same history transformation for the summarizer ---
            const transformedHistory = history.map((msg: any) => ({
                role: msg.type === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            })).filter((msg: any) => msg.parts[0].text && msg.role);

            const chat = summarizerModel.startChat({ history: [...transformedHistory, { role: 'user', parts: [{ text: userPrompt }] }] });
            const result = await chat.sendMessage(`Here is the command output:\\n\\n${output}`);
            const summary = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            res.json({ response: summary || output });

        } catch (summarizationError: any) {
            console.error("[Vertex AI] Error during summarization:", summarizationError);
            res.status(500).json({ response: `I was able to run the command, but I encountered an error while trying to summarize the results. Here is the raw output:\\n\\n> Executed: ${tool} ${command}\\n\\n${output}` });
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
