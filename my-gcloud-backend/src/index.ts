#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { Content, VertexAI } from '@google-cloud/vertexai';

// --- Initialize Vertex AI and Express ---
const vertex_ai = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: 'us-central1' });
const model = 'gemini-2.5-flash'; // Kept model as requested

// --- AGENT BRAIN 1: The Command Generator ---
const generativeModel = vertex_ai.preview.getGenerativeModel({
    model: model,
    systemInstruction: {
        role: 'system',
        parts: [{
            text: `You are an expert in Google Cloud command-line tools. Your goal is to translate a user\\'s request into a single, executable command for one of the following tools: gcloud, gsutil, kubectl, bq.

CRITICAL RULES:
1.  **Handle Greetings & General Questions:** If the user\\'s prompt is a greeting (e.g., "hello", "hi"), a question about your capabilities ("what can you do?"), or any other non-command request, respond with the single keyword: \`CONVERSATIONAL\`.
2.  **One Command Only:** If the user asks for an action on multiple resources (e.g., "get the row count for each table"), you MUST respond with the single keyword: \`ERROR_MULTIPLE_RESOURCES\`.
3.  **Error Correction Workflow:** If the previous turn was a model response explaining a command failure (e.g., a missing required flag like --location), and the user\\'s new prompt provides the missing information, your job is to RECONSTRUCT the original failed command with the new information. For example, if the user first said "list datascans" and the model responded "you need a location," and the user\\'s new prompt is "us-central1", you must generate the command \`gcloud dataplex datascans list --location=us-central1\`.
4.  **No Shell Operations:** The execution environment does NOT support shell features like pipes (\`|\`), redirection (\`>\`), or command chaining (\`&&\`). Do NOT include these in your command.
5.  **Pathing Rule:** For \`gsutil\`, all paths MUST start with \`gs://\`. Never generate \`file://\` paths.
6.  **Strategy for Complex Questions:** When a user asks a question that requires calculation, counting, or querying, your primary job is NOT to answer directly. Instead, you must generate a command that retrieves the detailed metadata of the resource. For example, to get the number of rows in a BigQuery table, you MUST generate a \`bq show --format=json [PROJECT]:[DATASET].[TABLE]\` command. The subsequent summarization step will perform the actual calculation.
7.  **Kubernetes Two-Step Workflow:**
    a.  Interacting with a Kubernetes cluster requires credentials. If the user asks to perform a \`kubectl\` action and the conversation history does NOT show that credentials have already been successfully obtained for that specific cluster, your ONLY job is to generate the \`gcloud container clusters get-credentials\` command.
    b.  ONLY if the history already shows a successful \`get-credentials\` command for the target cluster should you then generate the requested \`kubectl\` command.
8.  **Output JSON:** For valid commands, your final output MUST be a single, valid JSON object with two keys: \`tool\` and \`command\`.
9.  **Handle Missing Project:** If a command requires a project ID and one has not been provided in the prompt or conversation history, return the single keyword: \`NEEDS_PROJECT\`.
10. **Handle Missing Location:** If a command for a service like Dataplex requires a location/region and one has not been provided, return the single keyword: \`NEEDS_LOCATION\`.
11. **Handle Ambiguity:** If the request is ambiguous or impossible under these rules (and isn\\'t conversational), return the single keyword: \`ERROR\`.`
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

    // 2. Get the user\\'s newest prompt and the conversation history
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
            return res.status(500).json({ response: "The AI model returned an invalid or empty response." });
        }

        // --- NEW: Handle CONVERSATIONAL and informational keywords ---
        if (text === "CONVERSATIONAL") {
             return res.json({ response: "I am the Google Cloud Command Agent. I can help you interact with your Google Cloud environment using `gcloud`, `gsutil`, `kubectl`, and `bq`. You can ask me to do things like list resources, check metadata, or manage permissions. How can I help you today?" });
        }
        if (text === "NEEDS_PROJECT") {
            return res.json({ response: "I can do that. For which project would you like me to get this information?" });
        }
        if (text === "NEEDS_LOCATION") {
            return res.json({ response: "I can do that, but I need to know the Google Cloud location/region to check. Where should I look?" });
        }
        if (text === "ERROR_MULTIPLE_RESOURCES") {
            return res.status(400).json({ response: `I\\'m sorry, I can only perform operations on one resource (like a table or a file) at a time. Please ask me again for each resource individually.` });
        }
        if (text === "ERROR") {
            return res.status(400).json({ response: `I\\'m sorry, but I couldn\\'t translate that request into a specific gcloud command. Please try rephrasing your request.` });
        }

        // --- Parse the JSON response from the model ---
        const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
        const match = text.match(jsonRegex);
        const cleanedText = match ? match[1] : text;

        const aiResponse = JSON.parse(cleanedText);
        tool = aiResponse.tool;
        command = aiResponse.command;
        console.log(`[Vertex AI] Chosen tool: '${tool}', Generated command: '${command}'`);

    } catch (error: any) {
        console.error("[Vertex AI] Error during command generation:", error);
        if (error instanceof SyntaxError) { // Catches JSON parsing errors
             return res.status(500).json({ response: `Sorry, I received an invalid response from the AI model that I couldn\\'t understand. Please try your request again.` });
        }
        return res.status(500).json({ response: `An error occurred while communicating with the AI model: ${error.message}` });
    }

    // --- STEP 2: Execute the generated command with security checks ---

    const toolPaths: { [key: string]: string } = {
        'gcloud': '/usr/bin/gcloud',
        'gsutil': '/usr/bin/gsutil',
        'kubectl': '/usr/bin/kubectl',
        'bq': '/usr/bin/bq'
    };
    const executablePath = toolPaths[tool];

    if (!executablePath) {
        return res.status(403).json({ response: `The command tool '${tool}' is not in the list of allowed tools.` });
    }

    const args = command.split(" ");
    if (args.length > 0 && args[0] === tool) {
        args.shift();
    }

    const child = spawn(executablePath, args, {
        env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1", CLOUDSDK_AUTH_ACCESS_TOKEN: accessToken },
    });

    let output = "";
    let error = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));
    child.on("error", (err) => {
        console.error(`[SPAWN] System Error: Failed to start command '${executablePath}'. Error: ${err.message}`);
        res.status(500).json({ response: `System Error: Failed to start the command process. Please ensure the execution environment is set up correctly.` });
    });

    // --- STEP 3: Summarize success OR interpret failure ---
    child.on("close", async (code) => {
        if (code !== 0) {
            // --- Handle FAILURE by having the AI interpret the error ---
            console.error(`[${tool}] Command failed with exit code ${code}:\n${error}`);
            try {
                const errorAnalyzerModel = vertex_ai.preview.getGenerativeModel({
                    model: model,
                    systemInstruction: {
                        role: 'system',
                        parts: [{ text: `You are a helpful Google Cloud assistant. A command has failed. Your goal is to explain the technical error message to a user in a simple, human-readable way. RULES: Do not show the user the raw error message. Analyze the error and explain the likely root cause. Provide a clear, concise, and friendly explanation of the problem and suggest a solution. If the error indicates a missing flag (like --location or --project), be sure to ask the user for it.` }]
                    }
                });
                const result = await errorAnalyzerModel.generateContent(error);
                const friendlyError = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                return res.status(400).json({ response: friendlyError || `The command failed, and I was unable to determine the cause.` });

            } catch (analysisError: any) {
                console.error("[Vertex AI] Error during error analysis:", analysisError);
                return res.status(500).json({ response: `The command failed, and I was unable to analyze the error. Here is the raw error:\n\n${error}` });
            }
        }

        // --- Handle SUCCESS by having the AI summarize the output ---
        try {
            const summarizerModel = vertex_ai.preview.getGenerativeModel({
                model: model,
                systemInstruction: {
                    role: 'system',
                    parts: [{ text: `You are a helpful Google Cloud assistant. Your goal is to summarize the output of a command in a clear, conversational way.

CRITICAL RULES:
1.  **Directly Answer:** Your summary should directly answer the user\\'s original request, which was: '${userPrompt}'.
2.  **Handle Metadata:** If the output is a JSON object containing metadata, find the specific field that answers the user\\'s question (e.g., \`numRows\` for a row count, \`numBytes\` for table size) and present it clearly.
3.  **Handle Kubernetes Credentials:** If the original command was \`gcloud container clusters get-credentials\` and the output includes \`kubeconfig entry generated\`, your summary MUST be: "Okay, I\\'ve now configured access to that cluster. Please ask me again to list the pods (or perform your desired action), and I\\'ll be able to do it."` }]
                }
            });

            const transformedHistory = history.map((msg: any) => ({
                role: msg.type === 'user' ? 'user' : 'model',
                parts: [{ text: msg.content }]
            })).filter((msg: any) => msg.parts[0].text && msg.role);

            const chat = summarizerModel.startChat({ history: [...transformedHistory, { role: 'user', parts: [{ text: userPrompt }] }] });
            const result = await chat.sendMessage(`Here is the command output:\n\n${output}`);
            const summary = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            res.json({ response: summary || output }); // Fallback to raw output if summary fails

        } catch (summarizationError: any) {
            console.error("[Vertex AI] Error during summarization:", summarizationError);
            res.status(500).json({ response: `I was able to run the command, but I encountered an error while trying to summarize the results. Here is the raw output:\n\n> Executed: ${tool} ${command}\n\n${output}` });
        }
    });
});

// This section is for the separate MCP-style backend and remains unchanged.
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
