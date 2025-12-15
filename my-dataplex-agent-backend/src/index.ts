
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
// Corrected import to the new TypeScript tool
import { gcloudTool } from "./tools/gcloud-tool.js";

// --- Define the structure of the request body for type safety ---
interface InvokeRequestBody {
    prompt: string;
    conversation_id?: string;
}

// --- 1. Agent Configuration ---
const model = new ChatVertexAI({
  model: "gemini-2.5-pro",
  temperature: 0,
});

const tools = [gcloudTool];

const systemPrompt = `You are a highly capable Google Cloud assistant. Your primary goal is to help users by executing gcloud commands, with a specialization in Dataplex.

**CRITICAL RULES:**

1.  **REQUIRE PROJECT & LOCATION:** To function, you often need a Google Cloud Project ID and a Location/Region. The user MUST provide these.
    *   First, check the user's most recent message for the project and location.
    *   If not found, check the conversation history for them.
    *   **IF a project or location is still missing**, you MUST stop and ask the user to provide the missing information. Do NOT try to guess and do NOT use any tools. Example response: "I can do that, but I need the Google Cloud Project ID and location. Could you please provide them?"

2.  **TWO-STEP STRATEGY FOR DETAILS BY NAME:** When a user asks for "details" or "rules" for a resource using its display name (e.g., "details for 'My DQ Scan'"), you MUST use a two-step process:
    *   **STEP 1: Find the full resource ID.** Use the 'gcloud_cli_tool' to run a 'list' command with a '--filter' to find the exact resource. The output will contain the full resource name/ID.
    *   **STEP 2: Describe the resource.** Use the 'gcloud_cli_tool' again, this time with the 'describe' command and the full ID you found in Step 1. Do not guess the ID. You must get it from the output of the list command first.

3.  **TOOL SYNTAX:**
    *   The input for the 'gcloud_cli_tool' is the command string *without* the 'gcloud' prefix.
    *   Always include the project and location/region flags ('--project=' and '--location=') in your commands.
`;

// --- 2. Prompt Template ---
const prompt = ChatPromptTemplate.fromMessages([
  ["system", systemPrompt],
  new MessagesPlaceholder("chat_history"),
  ["human", "{input}"],
  new MessagesPlaceholder("agent_scratchpad"),
]);

// --- 3. Agent & Executor ---
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

// --- 4. In-Memory Storage for Chat Histories ---
const chatHistories = new Map();

// --- 5. Express Web Server ---
const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Correctly typed the Express request and response
app.post("/", async (req: Request<{}, {}, InvokeRequestBody>, res: Response) => {
  try {
    const { prompt: input, conversation_id: convId } = req.body;
    let conversation_id = convId || uuidv4();

    if (!input) {
      return res.status(400).json({ response: "Request body must include 'prompt'" });
    }

    const history = chatHistories.get(conversation_id) || [];
    
    console.log(`\n---\nInvoking agent for conversation [${conversation_id}] with input: \"${input}\"\n---\n`);

    const result = await agentExecutor.invoke({
      input: input,
      chat_history: history,
    });

    history.push(new HumanMessage(input));
    history.push(new AIMessage(result.output as string));
    // Corrected the typo from 'chatHistries' to 'chatHistories'
    chatHistories.set(conversation_id, history);

    res.json({ response: result.output, conversation_id: conversation_id });

  } catch (error: any) {
    console.error("Error invoking agent:", error);
    res.status(500).json({ response: `Failed to invoke agent: ${error.message}` });
  }
});

app.listen(port, () => {
  console.log(`Dataplex Langchain Agent server listening on http://localhost:${port}`);
});
