#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { VertexAI } from '@google-cloud/vertexai';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { runGcloudCommand } from "./tools/run_gcloud_command.js";

// Initialize the Vertex AI client, using an environment variable for the project ID.
const vertex_ai = new VertexAI({ project: process.env.GCLOUD_PROJECT, location: 'us-central1' });
const model = 'gemini-2.5-flash'; // Using the model you specified.

const generativeModel = vertex_ai.preview.getGenerativeModel({
    model: model,
});

// Initialize Express
const app = express();
app.use(cors());
app.use(express.json());

// --- UPDATED REST Endpoint for AgentUI with Natural Language Summarization ---
app.post("/api/gcloud", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ response: 'Authorization (Access Token) not provided or invalid' });
    }
    const accessToken = authHeader.split(' ')[1];

    const { prompt: userPrompt } = req.body;
    if (!userPrompt) {
        return res.status(400).json({ response: 'Prompt not provided in the request body' });
    }

    // --- STEP 1: Translate the natural language prompt into a gcloud command ---
    let gcloudCommand;
    try {
        const commandGenPrompt = `
        You are an expert in the Google Cloud CLI (gcloud).
        Translate the following user request into a single, executable gcloud command.
        - Only output the gcloud command itself.
        - Do not include any explanation, preamble, or markdown formatting.
        - Do not include the "gcloud" prefix in the command.
        - If the request is ambiguous, too complex, or cannot be translated into a gcloud command, respond with the single word "ERROR".

        User Request: "${userPrompt}"

        Resulting Command:`;

        const result = await generativeModel.generateContent(commandGenPrompt);
        const response = result.response;
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        if (!text) {
            console.error("[Vertex AI] Error: Command generation model returned invalid response.", JSON.stringify(response));
            return res.status(500).json({ response: "The AI model returned an invalid or empty response for command generation." });
        }

        if (text === "ERROR") {
            return res.status(400).json({ response: `I'm sorry, but I couldn't translate that request into a specific gcloud command. Please try rephrasing your request.` });
        }
        gcloudCommand = text;
        console.log(`[Vertex AI] Generated command: 'gcloud ${gcloudCommand}'`);

    } catch (error: any) {
        console.error("[Vertex AI] Error during command generation:", error);
        return res.status(500).json({ response: `Error communicating with the AI model for command generation: ${error.message}` });
    }

    // --- STEP 2: Execute the generated gcloud command ---
    const args = gcloudCommand.split(" ");
    const child = spawn("gcloud", args, {
        env: {
            ...process.env,
            CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
            CLOUDSDK_AUTH_ACCESS_TOKEN: accessToken
        },
    });

    let output = "";
    let error = "";
    child.stdout.on("data", (data) => (output += data.toString()));
    child.stderr.on("data", (data) => (error += data.toString()));

    child.on("error", (err) => {
        res.status(500).json({ response: `System Error: Failed to start gcloud process. Error: ${err.message}` });
    });

    // --- STEP 3: Summarize the output or return the error ---
    child.on("close", async (code) => {
        if (code !== 0) {
            // If the command failed, return the raw error.
            return res.status(400).json({ response: `Gcloud Error (Exit Code ${code}):\n${error || `Command: gcloud ${gcloudCommand}`}` });
        }

        // If the command succeeded, proceed to summarization.
        try {
            const summarizationPrompt = `
            You are a helpful Google Cloud assistant.
            A user gave the following request: "${userPrompt}"
            To answer this, you ran the following command: \`gcloud ${gcloudCommand}\`
            This produced the following output:
            \`\`\`
            ${output}
            \`\`\`
            Summarize the output in a clear, concise, and friendly way.
            - Do not just restate the raw output.
            - Explain what the information means.
            - Do not include the original prompt or the command you ran in your response.
            - If the output is empty or indicates no results, state that clearly (e.g., "I couldn't find any resources that match your request.").`;

            const result = await generativeModel.generateContent(summarizationPrompt);
            const response = result.response;
            const summary = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

            if (!summary) {
                console.error("[Vertex AI] Error: Summarization model returned invalid response.", JSON.stringify(response));
                // Fallback to sending the raw output if summarization fails.
                return res.json({ response: `> Executed: gcloud ${gcloudCommand}\\n\\n${output}` });
            }
            
            // Send the final, summarized response.
            res.json({ response: summary });

        } catch (summarizationError: any) {
            console.error("[Vertex AI] Error during summarization:", summarizationError);
            // If summarization fails, fall back to sending the raw output as a last resort.
            res.status(500).json({
                response: `I was able to run the command, but I encountered an error while trying to summarize the results. Here is the raw output:\\n\\n> Executed: gcloud ${gcloudCommand}\\n\\n${output}`
            });
        }
    });
});


// --- Existing MCP Server Logic (unchanged) ---
const server = new McpServer({
    name: "gcloud-mcp-backend",
    version: "1.0.0",
});

server.tool(
    "run_gcloud_command",
    runGcloudCommand.parameters,
    runGcloudCommand.execute
);

let transport: SSEServerTransport;

app.get("/sse", async (req, res) => {
    console.log("Client connected via SSE");
    transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
});

app.post("/messages", async (req, res) => {
    if (!transport) {
        res.status(500).send("Transport not initialized");
        return;
    }
    await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`-> MCP SSE endpoint available at /sse`);
    console.log(`-> AgentUI REST endpoint available at /api/gcloud`);
});
