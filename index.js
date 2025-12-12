import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from 'uuid';
import { ChatVertexAI } from "@langchain/google-vertexai";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { bigQueryTool } from "./src/tools/bigquery-tool.js";
import { bqCliTool } from "./src/tools/bq-cli-tool.js";

// --- Agent Configuration ---
const model = new ChatVertexAI({
  model: "gemini-2.5-pro",
  temperature: 0,
});

const tools = [bigQueryTool, bqCliTool];

// The full system instructions for the agent.
const systemPrompt = `You are a brilliant Google Cloud data analyst. Your goal is to answer user questions about BigQuery.

**CRITICAL RULE: You require a Google Cloud Project ID to function.**

**Here are the tools you have and how to use them:**
1.  \`bigquery_sql_query\`:
    -   **Purpose:** Use this ONLY for running SQL queries against tables to retrieve actual data (e.g., sum sales, count users, find specific records).
    -   **Input:** MUST be a complete and valid BigQuery SQL query string.
    -   **Syntax:** You MUST wrap all project, dataset, and table names in backticks (\`). Example: \`SELECT COUNT(*) FROM \`my-project.my_dataset.my_table\`\`

2.  \`bq_cli_tool\`:
    -   **Purpose:** Use this ONLY for BigQuery command-line (bq) operations, specifically for **metadata tasks** like:
        -   **Listing datasets** in a project.
        -   **Listing tables** within a dataset.
        -   **Getting detailed information or schema** for a specific dataset or table.
    -   **Input:** MUST be a valid 'bq' command string, WITHOUT the 'bq' prefix.
    -   **Examples:**
        -   To list datasets in project 'my-project-id': "ls --project_id=my-project-id"
        -   To list tables in 'my_dataset' within 'my-project-id': "ls --project_id=my-project-id my_dataset"
        -   To show info for 'my_dataset': "show --dataset=my_dataset --project_id=my-project-id"

**Your Process:**
1.  First, analyze the user's request to see if a project ID is mentioned. If it is, use it.
2.  Check the conversation history to see if a project ID was mentioned in a previous turn. If it was, you MUST reuse it.
3.  **IF a project ID is NOT found in the current request OR in the history**, you must stop and ask the user to provide one. Your response should be: "I can do that. Could you please provide the Google Cloud Project ID you'd like me to use?" Do NOT try to guess the project ID and do NOT use any tools.
4.  **IF a project ID IS available**:
    - If the request is about **listing datasets or tables, or getting general metadata (like schema)**, you MUST use the \`bq_cli_tool\`.
    - If the request is about **querying data from a table (e.g., counting, summing, filtering rows)**, you MUST use the \`bigquery_sql_query\` tool.
    - Always ensure the project ID and any other necessary details are correctly included in the tool's input.`;

// --- CORRECTED PROMPT TEMPLATE ---
// This template now includes all three required placeholders: input, chat_history, and agent_scratchpad.
const prompt = ChatPromptTemplate.fromMessages([
  ["system", systemPrompt],
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

const agent = await createToolCallingAgent({
  llm: model,
  tools,
  prompt,
});

const agentExecutor = new AgentExecutor({
  agent,
  tools,
  verbose: true,
});

// --- In-Memory Storage for Chat Histories ---
const chatHistories = new Map();

// --- Final, Production-Ready Web Server ---
const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());
app.use(cors());

app.post("/invoke", async (req, res) => {
  try {
    const { input } = req.body;
    let conversation_id = req.body.conversation_id;
    if (!conversation_id) {
      conversation_id = uuidv4();
      console.log(`New conversation started with ID: ${conversation_id}`);
    }

    if (!input) {
      return res.status(400).json({ error: "Request must include 'input'" });
    }

    const history = chatHistories.get(conversation_id) || [];
    
    console.log(`\n---\nInvoking for conversation [${conversation_id}] with input: "${input}"\n---\n`);

    const result = await agentExecutor.invoke({
      input: input,
      chat_history: history,
    });

    history.push(new HumanMessage(input));
    history.push(new AIMessage(result.output));
    chatHistories.set(conversation_id, history);

    res.json({ output: result.output, conversation_id: conversation_id });

  } catch (error) {
    console.error("Error invoking agent:", error);
    res.status(500).json({ error: "Failed to invoke agent" });
  }
});

app.listen(port, () => {
  console.log(`Agent server listening on http://localhost:${port}`);
});