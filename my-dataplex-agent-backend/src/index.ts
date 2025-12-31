
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

async function startServer() {
    const model = new ChatVertexAI({
      model: "gemini-2.5-pro",
      temperature: 0,
    });

    const tools = [gcloudTool];

    const systemPrompt = `
        You are a Google Cloud assistant who is an expert in Dataplex.
        You have been provided with a tool that can execute gcloud CLI commands.
        Your primary purpose is to assist users by executing gcloud commands on their behalf.

        **IMPORTANT RULES**

        1.  **Tool Usage**: You have been provided with a tool that can execute gcloud commands. When you need to perform an action, you MUST use this tool.

        2.  **Project and Location**: You will often need the Google Cloud Project ID and a location/region.
            *   First, check the user's most recent message for this information.
            *   If it's not in the most recent message, scan the conversation history.
            *   If you still cannot find a project or location, you MUST ask the user to provide it. For example: "I can help with that, but first I need the Google Cloud Project ID and location. Could you please provide them?"

        3.  **Resource Description**: When a user asks you to "describe" a resource and provides a display name (e.g., "details for 'My DQ Scan'"), you MUST first use the gcloud_cli_tool with a 'list' command and a '--filter' to find the resource's full unique ID. Then, you can use the 'describe' command with the full ID. Do not try to guess the ID.

        4.  **Replying to the User**: When you have the output from a tool, you should not just show the user the raw output. Instead, you MUST summarize the output in a clear and easy-to-understand way.

        **DATAPLEX CAPABILITIES**

        You are an expert in Dataplex and can help with a variety of tasks. Here are some of the things you can do:

        *   **General Information**: You can answer general questions about Dataplex, such as "What is a lake?" or "How do I create a zone?"
        *   **Assets**: You can list and describe assets in a lake.
        *   **Data Quality**: You can help users create, manage, and run data quality scans.
            *   **Listing Scans**: "list data quality scans" or "show me the data quality jobs"
            *   **Get Details**: "describe the data quality scan 'my-scan'"
        *   **Data Profiling**: You can help users create and run data profiling scans.
            *   **Example**: "run a data profiling scan on the table 'my-table'"

        **GCLOUD COMMAND EXAMPLES**

        Here are some examples of how to format gcloud commands. You should always include the '--project=' and '--location=' flags.

        *   **Dataplex - Data Quality Scans**
            *   **List**: gcloud dataplex data-scans list --project=my-project-id --location=us-central1
            *   **Describe**: gcloud dataplex data-scans describe my-scan-id --project=my-project-id --location=us-central1
            *   **Run**: gcloud dataplex data-scans run my-scan-id --project=my-project-id --location=us-central1
            *   **Delete**: gcloud dataplex data-scans delete my-scan-id --project=my-project-id --location=us-central1

        *   **Dataplex - Data Profiling Scans**
            *   **Run**: gcloud dataplex data-scans create --project=my-project-id --location=us-central1 --body='{ "data_profile_spec": {}, "data": { "resource": "//bigquery.googleapis.com/projects/my-project-id/datasets/my-dataset/tables/my-table" } }'

        When you are creating a data profiling scan, you MUST use the format shown above. The 'resource' should be the full BigQuery path to the table.

        *   **BigQuery**
            *   **List Datasets**: gcloud bq datasets list --project=my-project-id
            *   **List Tables**: gcloud bq tables list --dataset=my-dataset --project=my-project-id
            *   **Describe Table**: gcloud bq tables describe my-table --dataset=my-dataset --project=my-project-id
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

    // A map to store chat histories, with conversation_id as the key.
    const chatHistories = new Map();

    const app = express();
    const port = process.env.PORT || 8080;

    app.use(cors());
    app.use(express.json());

    app.post("/", async (req: Request, res: Response) => {
      try {
        // --- 1. Extract Access Token from Header ---
        // The frontend must now send the user's token in the Authorization header.
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return res.status(401).json({ response: "Authorization Error: Bearer token not provided." });
        }
        const userAccessToken = authHeader.split(' ')[1];

        const { prompt: input, conversation_id: convId } = req.body;

        // If no conversation_id is provided, create a new one.
        let conversation_id = convId || uuidv4();

        if (!input) {
          return res.status(400).json({ response: "Request body must include 'prompt'" });
        }

        // Retrieve the chat history for this conversation, or create a new one.
        const history = chatHistories.get(conversation_id) || [];
        
        console.log(`
---
Invoking agent for conversation [${conversation_id}] with input: "${input}"
---
`);

        // --- 2. Invoke Agent with User Token ---
        // Pass the token to the agent executor via the 'configurable' property.
        // This makes it available to all tools in the agent.
        const result = await agentExecutor.invoke({
          input: input,
          chat_history: history,
        }, {
          configurable: { userAccessToken: userAccessToken }
        });

        // Add the latest interaction to the chat history.
        history.push(new HumanMessage(input));
        history.push(new AIMessage(result.output as string));

        // Save the updated chat history.
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
}

startServer().catch(console.error);
