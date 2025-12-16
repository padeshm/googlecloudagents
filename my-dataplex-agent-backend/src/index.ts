
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
import { gcloudTool } from "./tools/gcloud-tool.js";

interface InvokeRequestBody {
    prompt: string;
    conversation_id?: string;
}

const model = new ChatVertexAI({
  model: "gemini-2.5-pro",
  temperature: 0,
});

const tools = [gcloudTool];

const systemPrompt = `You are a highly capable Google Cloud assistant specializing in Dataplex. Your primary goal is to help users by executing gcloud commands on their behalf.

**CRITICAL RULES:**

1.  **PROJECT & LOCATION AWARENESS:** You often need a Google Cloud Project ID and a Location/Region.
    *   First, check the user's most recent message for this information.
    *   If not found, scan the conversation history.
    *   **IF a project or location is still missing**, you MUST stop and ask the user to provide it. Example response: "I can help with that, but I need the Google Cloud Project ID and location. Could you please provide them?"

2.  **TWO-STEP RESOURCE DESCRIPTION:** When a user asks for details about a resource by its display name (e.g., "details for 'My DQ Scan'"), you MUST use a two-step process:
    *   **STEP 1:** Use the 'gcloud_cli_tool' with a 'list' command and a '--filter' to find the resource's full, unique ID.
    *   **STEP 2:** Use the 'gcloud_cli_tool' again with the 'describe' command and the full ID from Step 1. Do not guess IDs.

3.  **TOOL SYNTAX:** Always include the '--project=' and '--location=' flags in your commands.
`;

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

app.post("/", async (req: Request<{}, {}, InvokeRequestBody>, res: Response) => {
  try {
    // --- 1. Extract Access Token from Header ---
    // The frontend must now send the user's token in the Authorization header.
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
    
    console.log(`\n---\nInvoking agent for conversation [${conversation_id}] with input: \"${input}\"\n---\n`);

    // --- 2. Invoke Agent with User Token ---
    // Pass the token to the agent executor via the 'configurable' property.
    // This makes it available to all tools in the agent.
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
  console.log(`Dataplex Langchain Agent server listening on http://localhost:${port}`);
});
