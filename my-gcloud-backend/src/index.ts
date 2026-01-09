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

async function executeCommand(tool: string, command: string, accessToken: string): Promise<{ code: number | null, output: string, error: string }> {
    return new Promise((resolve) => {
        const executablePath = `/usr/bin/${tool}`;
        let args = command.split(" ").filter(arg => arg);

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
        
        child.on("error", (err) => {
            // This is for spawn errors (e.g., command not found)
            error += err.message;
            resolve({ code: -1, output, error });
        });

        child.on("close", (code) => {
            resolve({ code, output, error });
        });
    });
}

app.post("/api/gcloud", async (req, res) => {
    console.log("--- NEW GCLOUD-BACKEND REQUEST ---");
    console.log(`[REQUEST_BODY]: ${JSON.stringify(req.body)}`);

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ response: 'Authorization (Access Token) not provided or invalid' });
    }
    const accessToken = authHeader.split(' ')[1];

    let { prompt: userPrompt, history = [] } = req.body;
    if (!userPrompt) {
        return res.status(400).json({ response: 'Prompt not provided in the request body' });
    }

    let finalOutput = "";
    let finalError = "";
    let finalCode: number | null = 0;

    for (let i = 0; i < 2; i++) { // Allow for a maximum of 2 chained commands
        const transformedHistory = history.map((msg: any) => ({
            role: msg.type === 'user' ? 'user' : 'model',
            parts: [{ text: msg.content }]
        })).filter((msg: any) => msg.parts[0].text && msg.role);

        try {
            const chat = generativeModel.startChat({ history: transformedHistory as Content[] });
            const result = await chat.sendMessage(userPrompt);
            const rawResponseText = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

            if (!rawResponseText || rawResponseText.toUpperCase() === "ERROR") {
                return res.status(400).json({ response: `I\'m sorry, but I couldn\'t translate that request into a valid command. Please try rephrasing your request.` });
            }

            const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
            const match = rawResponseText.match(jsonRegex);
            const cleanedText = match ? match[1] : rawResponseText;
            const aiResponse = JSON.parse(cleanedText);

            const { tool, command } = aiResponse;
            console.log(`[ATTEMPT ${i + 1}] Parsed Command:`, { tool, command });

            const execResult = await executeCommand(tool, command, accessToken);
            finalCode = execResult.code;
            finalOutput = execResult.output;
            finalError = execResult.error;
            
            // Update history for the next potential loop
            history.push({ type: 'user', content: userPrompt });
            history.push({ type: 'bot', content: `> Executed: ${tool} ${command}\n\n${execResult.output}` });

            const isPrerequisite = command.includes('container clusters get-credentials') || command.includes('storage buckets describe');

            if (finalCode === 0 && isPrerequisite && i < 1) {
                console.log(`[ATTEMPT ${i + 1}] Prerequisite command successful. Looping to get next command.`);
                continue; // Loop to run the generator again with updated history
            } else {
                break; // Exit the loop on final command, error, or loop limit
            }
        } catch (error: any) {
            console.error("[LOOP ERROR]", error);
            return res.status(500).json({ response: `An internal error occurred: ${error.message}` });
        }
    }

    // --- Final Response Handling ---
    if (finalCode !== 0) {
        try {
            const errorAnalyzerModel = vertex_ai.getGenerativeModel({ model: model, systemInstruction: { role: 'system', parts: [{ text: `A command failed. Explain the error in a simple, human-readable way and suggest a solution. If a flag is missing, ask for it.` }] } });
            const result = await errorAnalyzerModel.generateContent(finalError);
            const friendlyError = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            res.status(400).json({ response: friendlyError || `The command failed, and I was unable to determine the cause.` });
        } catch (analysisError: any) {
            res.status(500).json({ response: `The command failed, and I was unable to analyze the error. Raw error:\n\n${finalError}` });
        }
    } else {
        try {
            const summarizerPrompt = `You are a helpful Google Cloud assistant. Summarize the following command output to directly answer the user\'s original request of: '${userPrompt}'. Be concise and clear.`;
            const summarizerModel = vertex_ai.getGenerativeModel({ model: model, systemInstruction: { role: 'system', parts: [{ text: summarizerPrompt }] } });
            const result = await summarizerModel.generateContent(`Command Output:\n\n${finalOutput}`);
            const summary = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            res.json({ response: summary || finalOutput });
        } catch (e) {
            res.json({ response: `I ran the command, but had trouble summarizing the results. Here is the raw output:\n\n${finalOutput}` });
        }
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`-> AgentUI REST endpoint available at /api/gcloud`);
});
