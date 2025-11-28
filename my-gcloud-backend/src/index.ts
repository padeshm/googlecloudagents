#!/usr/bin/env node
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { runGcloudCommand } from "./tools/run_gcloud_command.js";

// Initialize Express
const app = express();
app.use(cors());

// Initialize MCP Server
const server = new McpServer({
  name: "gcloud-mcp-backend",
  version: "1.0.0",
});

// Register the Tool
// We use the logic already present in the tool file, but register it here.
server.tool(
  "run_gcloud_command",
  runGcloudCommand.parameters, // We will need to slightly tweak the tool file to export this
  runGcloudCommand.execute
);

// --- HTTP ENDPOINTS ---

let transport: SSEServerTransport;

// SSE Endpoint (Client listens here)
app.get("/sse", async (req, res) => {
  console.log("Client connected via SSE");
  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

// Messages Endpoint (Client sends requests here)
app.post("/messages", async (req, res) => {
  if (!transport) {
    res.status(500).send("Transport not initialized");
    return;
  }
  await transport.handlePostMessage(req, res);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`MCP Server running on port ${PORT}`);
});