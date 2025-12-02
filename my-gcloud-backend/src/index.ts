#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { Content, VertexAI } from '@google-cloud/vertexai';

// --- Initialize Vertex AI and Express --- 
const vertex_ai = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: 'us-central1' });
const model = 'gemini-2.5-flash'; // CONFIRMED CORRECT MODEL NAME

// --- AGENT BRAIN 1: The Command Generator ---
const generativeModel = vertex_ai.preview.getGenerativeModel({ 
    model: model,
    systemInstruction: {
        role: 'system',
        parts: [{
            text: `You are an expert in Google Cloud command-line tools. Your goal is to translate a user's request into a single, executable command for one of the following tools: gcloud, gsutil, kubectl, bq.\n\nCRITICAL RULES:\n1.  **One Command Only:** You must only generate a single command for a single resource. If the user asks for an action on multiple resources (e.g., "get the row count for all tables"), you MUST respond with the keyword \`ERROR\` and explain that you can only operate on one at a time.\n2.  **No Shell Operations:** The execution environment does NOT support shell features like pipes (\`|\`), redirection (\`>\`), or command chaining (\`&&\`). Do NOT include these in your command.\n3.  **Pathing Rule:** For \`gsutil\`, all paths MUST start with \`gs://\`. Never generate \`file://\` paths.\n4.  **Strategy for Complex Questions:** When a user asks a question that requires calculation, counting, or querying (e.g., "how many rows are in this table?", "what are the 3 largest files?"), your primary job is NOT to answer directly. Instead, you must generate a command that retrieves the detailed metadata or a detailed list of the resource(s). The subsequent summarization step will perform the actual calculation.\n    -   **Example (gsutil 'largest files'):** User asks for the 3 largest files in a bucket. You generate the command \`gsutil ls -l gs://[BUCKET_NAME]/\`.\n    -   **Example (bq 'row count'):** User asks for the row count of a table. You generate the command \`bq show --format=json [DATASET].[TABLE]\`. This retrieves the table metadata, which contains the row count.\n5.  **Kubernetes Two-Step Workflow:**\n    a.  Interacting with a Kubernetes cluster requires credentials. If the user asks to perform a \`kubectl\` action (like listing pods, services, etc.) and the conversation history does NOT show that credentials have already been successfully obtained for that specific cluster, your ONLY job is to generate the \`gcloud container clusters get-credentials\` command. You MUST find the cluster name and its location/region from the conversation history to build this command.\n    b.  ONLY if the history already shows a successful \`get-credentials\` command for the target cluster should you then generate the requested \`kubectl\` command.\n6.  **Output JSON:** Your final output MUST be a single, valid JSON object with two keys:\n    -   \`tool\`: A string containing the name of the chosen tool.\n    -   \`command\`: A string containing the rest of the command to be executed.\n7.  **Handle Missing Project:** If a command requires a project ID and one has not been provided, return the single keyword: \`NEEDS_PROJECT\`.
8.  **Handle Ambiguity:** If the request is ambiguous or impossible under these rules, return the single keyword: \`ERROR\`.`
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

        const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
        const match = text.match(jsonRegex);
        const cleanedText = match ? match[1] : text;

        const aiResponse = JSON.parse(cleanedText);
        tool = aiResponse.tool;
        command = aiResponse.command;
        console.log(`[Vertex AI] Chosen tool: '${tool}', Generated command: '${command}'`);

    } catch (error: any) {
        console.error("[Vertex AI] Error during command generation:", error);
        if (error instanceof SyntaxError && error.message.includes("is not valid JSON")) {
             return res.status(500).json({ response: `Sorry, I encountered an error: I received an invalid response from the AI model. Please try your request again.` });
        }
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
    child.on("error", (err) => res.status(500).json({ response: `System Error: Failed to start the command process. Error: ${err.message}` }));

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
                            text: `You are a helpful Google Cloud assistant. A command has failed. Your goal is to explain the technical error message to a user in a simple, human-readable way. RULES: Do not show the user the raw error message. Analyze the error and explain the likely root cause. Provide a clear, concise, and friendly explanation of the problem and suggest a solution.`
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
                    parts: [{ text: `You are a helpful Google Cloud assistant. Your goal is to summarize the output of a command in a clear, conversational way.\n\nCRITICAL RULES:\n1.  **Directly Answer:** Your summary should directly answer the user's original request, which was: '${userPrompt}'.\n2.  **Handle Metadata:** If the output is a JSON object containing metadata, find the specific field that answers the user's question (e.g., \`numRows\` for a row count) and present it clearly.\n3.  **Handle Kubernetes Credentials:** If the original command was \`gcloud container clusters get-credentials\` and the output includes \`kubeconfig entry generated\`, your summary MUST be: "Okay, I've now configured access to that cluster. Please ask me again to list the pods (or perform your desired action), and I'll be able to do it."` }]
                }
            });

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
