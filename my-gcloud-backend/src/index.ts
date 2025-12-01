#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { VertexAI } from '@google-cloud/vertexai'; 
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { runGcloudCommand } from "./tools/run_gcloud_command.js";


// Initialize the correct Vertex AI client
const vertex_ai = new VertexAI({ location: 'us-central1' });
const model = 'gemini-2.5-flash'; // Use the model identifier for the Vertex AI SDK

const generativeModel = vertex_ai.preview.getGenerativeModel({
    model: model,
});


// Initialize Express
const app = express();
app.use(cors());
app.use(express.json()); // Add JSON body parser to read request bodies

// --- UPDATED REST Endpoint for AgentUI ---
app.post("/api/gcloud", async (req, res) => {
    // 1. Authenticate and get token for impersonation (unchanged)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ response: 'Authorization (Access Token) not provided or invalid' });
    }
    const accessToken = authHeader.split(' ')[1];

    // 2. Get the NATURAL LANGUAGE PROMPT from the request body
    const { prompt } = req.body;
    if (!prompt) {
        return res.status(400).json({ response: 'Prompt not provided in the request body' });
    }

    // 3. Use Gemini to translate the prompt into a gcloud command
    let gcloudCommand;
    try {
        const llmPrompt = `
        You are an expert in the Google Cloud CLI (gcloud).
        Translate the following user request into a single, executable gcloud command.
        - Only output the gcloud command itself.
        - Do not include any explanation, preamble, or markdown formatting.
        - Do not include the "gcloud" prefix in the command.
        - If the request is ambiguous, too complex, or cannot be translated into a gcloud command, respond with the single word "ERROR".

        User Request: "${prompt}"

        Resulting Command:`;

        const result = await generativeModel.generateContent(llmPrompt);
        const response = result.response;

        // THE FINAL FIX: Use optional chaining (?.) for robust, safe access.
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();

        // Now, we can safely check if we got any text.
        if (!text) {
            console.error("[Vertex AI] Error: No valid text returned from the model.", JSON.stringify(response));
            return res.status(500).json({ response: "The AI model returned an invalid or empty response." });
        }

        if (text === "ERROR") {
            return res.status(400).json({ response: `I'm sorry, but I couldn't translate that request into a specific gcloud command. Please try rephrasing your request.` });
        }
        gcloudCommand = text;
        console.log(`[Vertex AI] Generated command: 'gcloud ${gcloudCommand}'`); // Log for debugging

    } catch (error: any) {
        console.error("[Vertex AI] Error calling the API:", error);
        return res.status(500).json({ response: `There was an error communicating with the AI model: ${error.message}` });
    }

    // 4. Spawn gcloud with the user's token and the GENERATED command
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

    child.on("close", (code) => {
      // 5. Send back a unified response
      if (code !== 0) {
        res.status(400).json({ response: `Gcloud Error (Exit Code ${code}):\n${error || `Command: gcloud ${gcloudCommand}`}` });
      } else {
        // On success, include the executed command in the response for clarity
        res.json({ response: `> Executed: gcloud ${gcloudCommand}\n\n${output}` });
      }
    });

    child.on("error", (err) => {
      res.status(500).json({ response: `System Error: Failed to start gcloud process. Error: ${err.message}` });
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
// --- End of Existing MCP Logic ---


const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`-> MCP SSE endpoint available at /sse`);
  console.log(`-> AgentUI REST endpoint available at /api/gcloud`);
});
