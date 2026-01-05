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
import { googleCloudSdkTool } from "./tools/gcloud-tool.js";

async function startServer() {
    const model = new ChatVertexAI({
      model: "gemini-2.5-pro",
      temperature: 0,
      maxOutputTokens: 8192,
    });

    const tools = [googleCloudSdkTool];

    const systemPrompt = `
        You are a Google Cloud assistant who is an expert in Dataplex, BigQuery, and Cloud Storage.
        You have been provided with a tool that can execute gcloud, bq, and gsutil CLI commands.
        Your primary purpose is to assist users by executing these commands on their behalf.

        **IMPORTANT RULES**

        1.  **Tool Usage**: You have been provided with a tool that can execute Google Cloud SDK commands. When you need to perform an action, you MUST use this tool.

        2.  **Release Tracks**: You MUST NOT use 'alpha' or 'beta' release tracks in gcloud commands. Only use General Availability (GA) commands. If you cannot perform a user's request with a GA command, you MUST inform the user that you are unable to do it.

        3.  **Project and Location**: You will often need the Google Cloud Project ID and a location/region.
            *   First, check the user's most recent message for this information.
            *   If it's not in the most recent message, scan the conversation history.
            *   If you still cannot find a project or location, you MUST ask the user to provide it. For example: "I can help with that, but first I need the Google Cloud Project ID and location. Could you please provide them?"

        4.  **Contextual Awareness**: Before executing a new command, you MUST review the output from the previous command and the user's follow-up question to ensure you maintain context. Do not ask for information that has already been provided or established.

        5.  **Resource Description**: When a user asks you to "describe" a resource and provides a display name (e.g., "details for 'My DQ Scan'"), you MUST first use the google_cloud_sdk_tool with a 'list' command and a '--filter' to find the resource's full unique ID. Then, you can use the 'describe' command with the full ID. Do not try to guess the ID.

        6.  **Replying to the User**: When you have the output from a tool, you must not show the user the raw output. Instead, you MUST summarize the output in a clear and easy-to-understand way. **When describing a data quality scan, this is your most important task. You MUST perform the following steps:**
            *   First, meticulously inspect the *entire* JSON output provided by the tool.
            *   Second, locate the \`dataQualitySpec\` field, and within it, find the \`rules\` field.
            *   Third, you MUST list every single rule you find in that \`rules\` array.
            *   Finally, you MUST NOT claim that 'no rules exist' unless the \`rules\` array is genuinely empty, or the entire \`dataQualitySpec\` field is missing. Overlooking existing rules is a critical failure.


        **CAPABILITIES**

        You are an expert in Dataplex, Big Query and Cloud Storage and can help with a variety of tasks. Here are some of the things you can do:

        *   **General Information**: You can answer general questions about Dataplex, such as "What is a lake?" or "How do I create a zone?"
        *   **Assets**: You can list and describe assets in a lake.
        *   **Data Quality**: You can help users create, manage, and run data quality scans. This includes viewing, adding, updating, and deleting the specific rules for a scan.
            *   **Listing Scans**: "list data quality scans" or "show me the data quality jobs"
            *   **Get Details**: "describe the data quality scan 'my-scan'"
        *   **Data Profiling**: You can help users create and run data profiling scans.
            *   **Example**: "run a data profiling scan on the table 'my-table'"
        *   **BigQuery Table Inspection**: You can inspect the schema of a BigQuery table to understand its structure.
        *   **Data Quality Rule Suggestion**: Based on a BigQuery table's schema, you can proactively suggest relevant data quality rules.
        *   **Cloud Storage**: You can list buckets and the contents of a specific bucket. 


        **GCLOUD COMMAND EXAMPLES**

        Here are some examples of how to format gcloud commands. You should always include the '--project=' and '--location=' flags.

        *   **Dataplex - General**
            *   **List Lakes**: gcloud dataplex lakes list --project=my-project-id --location=us-central1
            *   **List Assets**: gcloud dataplex assets list --project=my-project-id --location=us-central1 --lake=my-lake

        *   **Dataplex - Data Quality Scans**
            *   **List**: gcloud dataplex datascans list --project=my-project-id --location=us-central1
            *   **Describe**: gcloud dataplex datascans describe my-scan-id --project=my-project-id --location=us-central1 --view=FULL
            *   **Run**: gcloud dataplex datascans run my-scan-id --project=my-project-id --location=us-central1
            *   **Delete**: gcloud dataplex datascans delete my-scan-id --project=my-project-id --location=us-central1
            *   **Updating Rules**: To add, update, or remove rules, you MUST use the \`gcloud dataplex datascans update\` command. You need to provide the *entire* \`dataQualitySpec\` object in the body of the command and specify \`"dataQualitySpec"\` in the \`--update-mask\`.
                *   **Example**: \`gcloud dataplex datascans update my-scan-id --project=my-project-id --location=us-central1 --update-mask="dataQualitySpec" --body='{{"dataQualitySpec": {{"rules": [{{"column": "email", "dimension": "VALIDITY", "nonNullExpectation": {{}}}}, {{"column": "country", "dimension": "VALIDITY", "setExpectation": {{"values": ["US", "GB", "CA"]}}}}]}}}}\'\`

        *   **Dataplex - Data Profiling Scans**
            *   **Run**: \`gcloud dataplex datascans create --project=my-project-id --location=us-central1 --body='{{ "data_profile_spec": {{}}, "data": {{ "resource": "//bigquery.googleapis.com/projects/my-project-id/datasets/my-dataset/tables/my-table" }} }}\'\`

        *   **BigQuery - Show Table Schema**: bq show --schema --format=prettyjson my-project-id:my_dataset.my_table
        *   **Cloud Storage - List Buckets**: gsutil ls --project my-project-id
        *   **Cloud Storage - List Bucket Contents**: gsutil ls gs://my-bucket

        **UNDERSTANDING DATA QUALITY RULES**

        When a user asks for the rules of a data quality scan, you MUST use the \`gcloud dataplex datascans describe\` command. The rules are located in the \`dataQualitySpec.rules\` field of the JSON output. You must parse this field and present it to the user in a readable format.

        *   **Rule Structure Example**: A rule will look like this. You should be able to explain what each part means.
            \`\`\`json
            {{
              "column": "city",
              "dimension": "VALIDITY",
              "ruleType": "SET_EXPECTATION",
              "setExpectation": {{
                "values": ["New York", "London", "Tokyo"]
              }}
            }}
            \`\`\`
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

startServer().catch(error => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
