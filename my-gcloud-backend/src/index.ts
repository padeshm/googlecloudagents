#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { Content, VertexAI } from '@google-cloud/vertexai';

// --- Initialize Vertex AI and Express ---
const vertex_ai = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: 'us-central1' });
const model = 'gemini-2.5-flash'; // Reverted to the correct model name

// --- AGENT BRAIN 1: The Command Generator ---
const generativeModel = vertex_ai.getGenerativeModel({
    model: model,
    systemInstruction: {
        role: 'system',
        parts: [{
            text: `You are an expert in Google Cloud command-line tools. Your sole purpose is to translate a user\'s natural language request into a single, executable command for one of the following tools: gcloud, gsutil, kubectl, bq. Do not engage in conversation.

CRITICAL RULES:
1.  **One Command Only:** If the user asks for an action on multiple resources, respond with the single keyword: \`ERROR_MULTIPLE_RESOURCES\`.
2.  **Error Correction:** If the conversation history shows a command failed due to a missing flag (like --location) and the user\'s new prompt provides that info, reconstruct the command with the new information.
3.  **No Shell Operations:** Do not use shell features like pipes (\`|\`), redirection (\`>\`), or chaining (\`&&\`).
4.  **gsutil Paths:** All gsutil paths MUST start with \`gs://\`.
5.  **Metadata Strategy:** For questions about resource details (like counts or sizes), generate a command to retrieve the full resource metadata (e.g., \`bq show --format=json ...\`).
6.  **Kubernetes Credentials:** If a \`kubectl\` command is requested, first check the history. If \`gcloud container clusters get-credentials\` has not already been successfully run for that cluster, you MUST generate that command first. Otherwise, generate the requested \`kubectl\` command.
7.  **Handle Missing Info:** If a command requires a project ID or location/region and it has not been provided, return the single keywords: \`NEEDS_PROJECT\` or \`NEEDS_LOCATION\`.
8.  **Output Format:** If you can generate a valid command, your output MUST be a single, valid JSON object with two keys: "tool" and "command". For all other cases where a command cannot be generated (e.g., ambiguity, impossible request), respond with the single keyword: \`ERROR\`.
`
        }]
    }
});

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/gcloud", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ response: 'Authorization (Access Token) not provided or invalid' });
    }
    const accessToken = authHeader.split(' ')[1];

    const { prompt: userPrompt, history = [] } = req.body;
    if (!userPrompt) {
        return res.status(400).json({ response: 'Prompt not provided in the request body' });
    }

    // --- NEW: Pre-emptive check for simple greetings ---
    const lowerCasePrompt = userPrompt.toLowerCase().trim();
    const GREETINGS = ["hello", "hi", "hey", "greetings"];
    if (GREETINGS.includes(lowerCasePrompt)) {
        return res.json({ response: "Hello! I\'m the Google Cloud Command Agent. How can I help you execute commands today?" });
    }
    if (lowerCasePrompt === "what can you do?" || lowerCasePrompt === "help") {
         return res.json({ response: "I can translate your requests into commands for `gcloud`, `gsutil`, `kubectl`, and `bq` to interact with your Google Cloud environment. For example, you can ask me to 'list all my GCE instances' or 'show the number of rows in the BigQuery table my_dataset.my_table'." });
    }

    // --- STEP 1: Translate prompt to command ---
    let tool: string;
    let command: string;
    try {
        const transformedHistory = history.map((msg: any) => ({
            role: msg.type === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        })).filter((msg: any) => msg.parts[0].text && msg.role);

        const chat = generativeModel.startChat({ history: transformedHistory as Content[] });
        const result = await chat.sendMessage(userPrompt);
        const rawResponseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

        if (!rawResponseText) {
            return res.status(500).json({ response: "The AI model returned an invalid or empty response." });
        }

        // Handle specific error keywords from the AI
        if (rawResponseText === "NEEDS_PROJECT") {
            return res.json({ response: "I can do that. For which project would you like me to get this information?" });
        }
        if (rawResponseText === "NEEDS_LOCATION") {
            return res.json({ response: "I can do that, but I need to know the Google Cloud location/region to check. Where should I look?" });
        }
        if (rawResponseText === "ERROR_MULTIPLE_RESOURCES") {
            return res.status(400).json({ response: `I\'m sorry, I can only perform operations on one resource at a time. Please ask me again for each resource individually.` });
        }
        if (rawResponseText === "ERROR") {
            return res.status(400).json({ response: `I\'m sorry, but I couldn\'t translate that request into a valid command. Please try rephrasing your request.` });
        }

        // Attempt to parse the response as a command JSON
        const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
        const match = rawResponseText.match(jsonRegex);
        const cleanedText = match ? match[1] : rawResponseText;
        
        const aiResponse = JSON.parse(cleanedText);
        tool = aiResponse.tool;
        command = aiResponse.command;
        console.log(`[Vertex AI] Parsed Command. Tool: '${tool}', Command: '${command}'`);

    } catch (error: any) {
        console.error("[Vertex AI] Error during command generation or parsing:", error);
        // If parsing fails, it means the AI gave a conversational answer we didn't expect.
        // We return that directly instead of crashing.
        return res.status(500).json({ response: `Sorry, an unexpected error occurred. The AI responded in a way I couldn\'t process. Please try rephrasing.` });
    }

    // --- STEP 2: Execute Command ---
    const toolPaths: { [key: string]: string } = {
        'gcloud': '/usr/bin/gcloud', 'gsutil': '/usr/bin/gsutil', 'kubectl': '/usr/bin/kubectl', 'bq': '/usr/bin/bq'
    };
    const executablePath = toolPaths[tool];
    if (!executablePath) {
        return res.status(403).json({ response: `The command tool '${tool}' is not allowed.` });
    }
    const args = command.split(" ").filter(arg => arg);
    if (args.length > 0 && args[0] === tool) args.shift();

    const child = spawn(executablePath, args, {
        env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: "1", CLOUDSDK_AUTH_ACCESS_TOKEN: accessToken },
    });

    let output = "";
    let error = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));
    child.on("error", (err) => {
        console.error(`[SPAWN] System Error: Failed to start command '${executablePath}'. Error: ${err.message}`);
        res.status(500).json({ response: `System Error: Failed to start the command process.` });
    });

    child.on("close", async (code) => {
        if (code !== 0) {
            console.error(`[${tool}] Command failed (code ${code}):\n${error}`);
            try {
                const errorAnalyzerModel = vertex_ai.getGenerativeModel({
                    model: model,
                    systemInstruction: { role: 'system', parts: [{ text: `You are a helpful Google Cloud assistant. A command has failed. Your goal is to explain the technical error message to a user in a simple, human-readable way. RULES: Do not show the user the raw error message. Analyze the error, explain the root cause, and suggest a solution. If a flag is missing (like --location), ask for it.` }] }
                });
                const result = await errorAnalyzerModel.generateContent(error);
                const friendlyError = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                return res.status(400).json({ response: friendlyError || `The command failed, and I was unable to determine the cause.` });
            } catch (analysisError: any) {
                console.error("[Vertex AI] Error during error analysis:", analysisError);
                return res.status(500).json({ response: `The command failed, and I was unable to analyze the error. Raw error:\n\n${error}` });
            }
        }

        try {
            const summarizerModel = vertex_ai.getGenerativeModel({
                model: model,
                systemInstruction: { role: 'system', parts: [{ text: `You are a helpful Google Cloud assistant. Your goal is to summarize the output of a command in a clear, conversational way. CRITICAL RULES: 1. Directly answer the user\'s original request: '${userPrompt}'. 2. If the output is JSON metadata, find the specific field that answers the question (e.g., \`numRows\`) and present it clearly. 3. If the command was \`gcloud container clusters get-credentials\` and was successful, your summary MUST be: "Okay, I\'ve now configured access to that cluster. Please ask me again to perform your desired action, and I\'ll be able to do it."` }] }
            });
            const chat = summarizerModel.startChat({ history: history.map((msg: any) => ({ role: msg.type === 'user' ? 'user' : 'model', parts: [{ text: msg.content }] })).filter((msg: any) => msg.parts[0].text && msg.role) as Content[] });
            const result = await chat.sendMessage(`Here is the command output:\n\n${output}`);
            const summary = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            res.json({ response: summary || output });
        } catch (summarizationError: any) {
            console.error("[Vertex AI] Error during summarization:", summarizationError);
            res.status(500).json({ response: `I was able to run the command, but had trouble summarizing the results. Here is the raw output:\n\n> Executed: ${tool} ${command}\n\n${output}` });
        }
    });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`-> AgentUI REST endpoint available at /api/gcloud`);
});
