#!/usr/bin/env node
// Triggering CI/CD
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { Content, VertexAI } from '@google-cloud/vertexai';

// --- Initialize Vertex AI and Express ---
const vertex_ai = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: 'us-central1' });
const model = 'gemini-2.5-pro';

// --- AGENT BRAIN 1: The Command Generator ---
const generativeModel = vertex_ai.getGenerativeModel({
    model: model,
    systemInstruction: {
        role: 'system',
        parts: [{
            text: `You are an expert in Google Cloud command-line tools. Your sole purpose is to translate a user\'s natural language request into a single, executable command for one of the following tools: gcloud, gsutil, kubectl, bq. Do not engage in conversation. If critical information is provided in a [CONTEXT] block, you MUST use it.

CRITICAL RULES:
1.  **Output Format:** If you can generate a valid command, your output MUST be a single, valid JSON object with two keys: "tool" and "command".
2.  **Error Keywords:** For any case where a command cannot be generated, you MUST respond with one of the following keywords: ERROR, NEEDS_PROJECT, NEEDS_LOCATION, ERROR_MULTIPLE_RESOURCES.
3.  **Context Usage:** You MUST prioritize information from the [CONTEXT] block.
4.  **Error Correction:** If the conversation history shows a command failed due to a missing flag (like --location) and the user\'s new prompt provides that info, reconstruct the command with the new information.
5.  **No Shell Operations:** Do not use shell features like pipes (\`|\`), redirection (\`>\`), or chaining (\`&&\`).
6.  **gsutil Paths:** All gsutil paths MUST start with \`gs://\`.
7.  **Metadata Strategy:** For questions about resource details, generate a command to retrieve the full resource metadata (e.g., \`bq show --format=json ...\`).
8.  **Kubernetes Credentials:** If a \`kubectl\` command is requested, first check the history. If \`gcloud container clusters get-credentials\` has not already been successfully run for that cluster, you MUST generate that command first. Otherwise, generate the requested \`kubectl\` command.
9.  **File Operations:**
    - To **list the files within a bucket**, you MUST use the \`gcloud storage ls\` command.
    - To **download, view, get, read, or see the content of a *specific* file** from a GCS bucket, first check the conversation history. If the bucket's location has not been determined, you MUST generate a \`gcloud storage buckets describe gs://BUCKET_NAME --format='value(location)'\` command. Only if the location is known should you generate the \`gcloud storage sign-url\` command, including the location with the \`--location\` flag.
10. **Contextual Follow-up:** For follow-up requests, you MUST reuse the full resource identifiers from the previous successful commands in the conversation history.`
        }]
    }
});

const app = express();
app.use(cors());
app.use(express.json());

// --- Helper Function to Extract Context ---
function extractContext(history: any[]): any {
    const context: any = {};
    if (history.length === 0) return context;

    const lastBotMessage = history[history.length - 1];

    if (lastBotMessage && lastBotMessage.content) {
        // Extract project from any gcloud command
        const projectMatch = lastBotMessage.content.match(/project \`([^`]+)\`/);
        if (projectMatch) context.project = projectMatch[1];

        // Extract bucket name from listing files
        const bucketMatch = lastBotMessage.content.match(/bucket \`([^`]+)\`/);
        if (bucketMatch) context.bucket = bucketMatch[1];

        // Extract instance name from VM list
        const instanceMatches = [...lastBotMessage.content.matchAll(/\*\*\s*([^\*]+)\*\* in the \`([^`]+)\` zone/g)];
        if (instanceMatches.length > 0) {
            context.instances = instanceMatches.map((m:any) => ({ name: m[1], zone: m[2] }));
        }
    }
    return context;
}

app.post("/api/gcloud", async (req, res) => {
    console.log("--- NEW GCLOUD-BACKEND REQUEST ---");
    console.log(`[REQUEST_BODY]: ${JSON.stringify(req.body)}`);

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ response: 'Authorization (Access Token) not provided or invalid' });
    }
    const accessToken = authHeader.split(' ')[1];

    const { prompt: userPrompt, history = [] } = req.body;
    if (!userPrompt) {
        return res.status(400).json({ response: 'Prompt not provided in the request body' });
    }
    
    const transformedHistory = history.map((msg: any) => ({
        role: msg.type === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
    })).filter((msg: any) => msg.parts[0].text && msg.role);

    const immediateContext = extractContext(history);
    let augmentedPrompt = userPrompt;
    if (Object.keys(immediateContext).length > 0) {
        const contextString = Object.entries(immediateContext)
            .map(([key, value]) => {
                if (key === 'instances') {
                    return `instances: ${JSON.stringify(value)}`;
                }
                return `${key}: ${value}`;
            })
            .join('\n');
        augmentedPrompt = `[CONTEXT]\n${contextString}\n\n[USER_PROMPT]\n${userPrompt}`;
    }
    console.log(`[AUGMENTED_PROMPT]: ${augmentedPrompt}`);

    let tool: string;
    let command: string;
    try {
        const chat = generativeModel.startChat({ history: transformedHistory as Content[] });
        const result = await chat.sendMessage(augmentedPrompt);
        const rawResponseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

        if (!rawResponseText) {
            return res.status(500).json({ response: "The AI model returned an invalid or empty response." });
        }

        console.log(`[AI_RESPONSE]: ${rawResponseText}`);

        const upperResponse = rawResponseText.toUpperCase();
        const errorMap: { [key: string]: string } = {
            NEEDS_PROJECT: "I can do that. For which project would you like me to get this information?",
            NEEDS_LOCATION: "I can do that, but I need to know the Google Cloud location/region to check. Where should I look?",
            ERROR_MULTIPLE_RESOURCES: `I\'m sorry, I can only perform operations on one resource at a time. Please ask me again for each resource individually.`,
            ERROR: `I\'m sorry, but I couldn\'t translate that request into a valid command. Please try rephrasing your request.`
        };
        if (errorMap[upperResponse]) {
            return res.status(400).json({ response: errorMap[upperResponse] });
        }

        const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
        const match = rawResponseText.match(jsonRegex);
        const cleanedText = match ? match[1] : rawResponseText;

        const aiResponse = JSON.parse(cleanedText);
        tool = aiResponse.tool;
        command = aiResponse.command;
        console.log(`[PARSED_COMMAND]: Tool: '${tool}', Command: '${command}'`);

    } catch (error: any) {
        console.error("[Vertex AI] Error during command generation or parsing:", error);
        return res.status(500).json({ response: `Sorry, I received an invalid response from the AI model. Please try your request again.` });
    }
    
    // --- Command Execution & Response ---
    const executablePath = `/usr/bin/${tool}`;
    let args = command.split(" ").filter(arg => arg);

    // --- FIX: Defensively remove the tool name if the AI includes it ---
    if (args.length > 0 && args[0] === tool) {
        args.shift();
    }

    const env: { [key: string]: string | undefined } = {
        ...process.env,
        CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
    };
    if (!command.includes('storage sign-url')) {
        env.CLOUDSDK_AUTH_ACCESS_TOKEN = accessToken;
    }

    const child = spawn(executablePath, args, { env: env as any });

    let output = "";
    let error = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));

    child.on("close", async (code) => {
        if (code !== 0) {
             try {
                const errorAnalyzerModel = vertex_ai.getGenerativeModel({ model: model, systemInstruction: { role: 'system', parts: [{ text: `A command failed. Explain the error in a simple, human-readable way and suggest a solution. If a flag is missing, ask for it.` }] } });
                const result = await errorAnalyzerModel.generateContent(error);
                const friendlyError = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                return res.status(400).json({ response: friendlyError || `The command failed, and I was unable to determine the cause.` });
            } catch (analysisError: any) {
                return res.status(500).json({ response: `The command failed, and I was unable to analyze the error. Raw error:\n\n${error}` });
            }
        }
        
        try {
             const summarizerModel = vertex_ai.getGenerativeModel({
                model: model,
                systemInstruction: { role: 'system', parts: [{ text: `You are a helpful Google Cloud assistant. Summarize the command output to directly answer the user\'s original request: '${userPrompt}'. Special Rules: 1. If the command was \`gcloud container clusters get-credentials\`, your summary MUST be: "Okay, I\'ve now configured access to that cluster. Please ask me again to perform your desired action, and I\'ll be able to do it.". 2. If the command was \`gcloud storage buckets describe\`, your summary MUST be: "I\'ve found the bucket\'s location. Please ask me again to get the file, and I\'ll be able to create the download link for you."` }] }
            });
            const result = await summarizerModel.generateContent(`Command Output:\n\n${output}`);
            const summary = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            res.json({ response: summary || output });
        } catch (e) {
            res.json({ response: `I ran the command, but had trouble summarizing the results. Here is the raw output:\n\n${output}` });
        }
    });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`-> AgentUI REST endpoint available at /api/gcloud`);
});
