import express, { Request, Response } from "express";
import cors from "cors";
import { v4 as uuidv4 } from 'uuid';
import { ChatVertexAI } from "@langchain/google-vertexai";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { bqCliTool } from "./tools/bq-cli-tool.js";
import { bigqueryTool } from "./tools/bigquery-tool.js";

interface InvokeRequestBody {
    prompt: string;
    conversation_id?: string;
}

const model = new ChatVertexAI({
  model: "gemini-2.5-pro",
  temperature: 0,
});

const tools = [bqCliTool, bigqueryTool];

const systemPrompt = `You are a brilliant Google Cloud data analyst. Your goal is to answer user questions about BigQuery.

**CRITICAL RULE: You require a Google Cloud Project ID to function.**

**Here are the tools you have and how to use them:**
1.  \`bigquery_sql_query\`:
    -   **Purpose:** Use this ONLY for running SQL queries against tables to retrieve actual data (e.g., sum sales, count users, find specific records).
    -   **Input:** MUST be a complete and valid BigQuery SQL query string.
    -   **Syntax:** You MUST wrap all project, dataset, and table names in backticks (\`\`). Example: \`SELECT COUNT(*) FROM \`my-project.my_dataset.my_table\`\`

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
    - Always ensure the project ID and any other necessary details are correctly included in the tool\'s input.`;

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

const chatHistories = new Map();

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

app.post("/invoke", async (req: Request<{}, {}, InvokeRequestBody>, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ response: "Authorization Error: Bearer token not provided." });
    }
    const userAccessToken = authHeader.split(' ')[1];

    const { prompt: input, conversation_id: convId } = req.body;
    let conversation_id = convId || uuidv4();

    if (!input) {
      return res.status(400).json({ response: "Request body must include 'prompt'" });
    }

    const history = chatHistories.get(conversation_id) || [];

    console.log(`\\n---\\nInvoking agent for conversation [${conversation_id}] with input: \\"${input}\\"\\n---\\n`);

    const result = await agentExecutor.invoke({
      input: input,
      chat_history: history,
    }, {
      configurable: {
        userAccessToken: userAccessToken,
      }
    });

    history.push(new HumanMessage(input));
    history.push(new AIMessage(result.output as string));
    chatHistories.set(conversation_id, history);

    res.json({ response: result.output, conversation_id: conversation_id });

  } catch (error: any) {
    console.error("Error invoking agent:", error);
    res.status(500).json({ response: `Failed to invoke agent: ${error.message}` });
  }
});

app.listen(port, () => {
  console.log(`BQ Agent server listening on http://localhost:${port}`);
});