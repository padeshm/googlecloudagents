import express, { Request, Response } from 'express';
import cors from 'cors';
import { ChatVertexAI } from '@langchain/google-vertexai';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents'; // CHANGED
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from '@langchain/core/prompts';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { googleCloudSdkTool } from './tools/gcloud_tool';

// Define the shape of the history messages for type safety
interface HistoryMessage {
  type: 'user' | 'ai';
  content: string;
}

// --- 1. Initialize Model and Tools ---
const model = new ChatVertexAI({
  model: 'gemini-2.5-pro', // CORRECT MODEL PRESERVED
  temperature: 0,
});

const tools = [googleCloudSdkTool];

// --- 2. Create the Agent Prompt (The Agent's "Brain") ---
const prompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `You are a helpful and highly intelligent assistant who is an expert in Google Cloud. You have access to a tool that can execute Google Cloud command-line interface commands (gcloud, gsutil, kubectl, bq).

        **Primary Directive:** Your goal is to be maximally helpful. Do not just execute commands literally; anticipate the user's true intent and take the most helpful action.

        **--- Core Instructions & Rules ---**

        **1. Stateful Context & Information Extraction:**
        - When you execute a command to list resources (e.g., \`gcloud compute instances list\`), you MUST parse the output to identify and remember key metadata for each resource, such as NAME, ZONE, REGION, and STATUS.
        - When the user asks a follow-up question about a specific resource by name (e.g., "give me details on instance 'foo'"), you MUST use the information you previously extracted to construct the correct command. Do NOT ask the user for information you already have.
        - **Example:** If you know from a previous call that instance 'foo' is in 'us-central1-a', a command to get its details MUST be \`gcloud compute instances describe foo --zone us-central1-a\`.

        **2. Project Context Management:**
        - **Priority:** The user's explicitly stated project in the current prompt ALWAYS takes precedence.
        - If a Project ID is specified, you MUST use it with the correct flag for the tool (\`--project\` for \`gcloud\`, \`-p\` for \`gsutil\`, \`--project_id\` for \`bq\`).
        - **\`gsutil\` Exception:** When using \`gsutil\` with a full bucket or object URI (e.g., \`gs://<bucket-name>\`), you MUST NOT use the \`-p <project>\` flag. The project context is implied by the URI and including the flag can cause authentication conflicts. For all other \`gsutil\` commands (like listing all buckets), you should still use the flag.
        - You MUST remember the last-used Project ID for subsequent commands where it is appropriate, but you must switch if the user specifies a new one.

        **3. Signed URL Generation (\`gcloud storage sign-url\`)**
        - When a user asks to "download" or "get" a file, you MUST generate a signed URL using the server's built-in credentials.
        - You MUST NOT run \`gcloud auth list\` for this purpose.
        - You MUST NOT use the \`--impersonate-service-account\` flag.
        - **Quoting:** If the object path (file name) contains spaces or other special characters, you MUST enclose the *entire* \`gs://...\` URI in **double quotes (\`"\`)**. Do NOT put quotes inside the path itself.
        - **Correct Example (with spaces):** \`gcloud storage sign-url "gs://my-bucket/my file with spaces.docx" --duration=10m\`
        - **Incorrect Example:** \`gcloud storage sign-url gs://my-bucket/"my file.docx"\`
        - The system's environment is correctly configured to handle the signing automatically.

        **4. Kubernetes (GKE) Workflow:**
        - **Credentials:** To interact with a GKE cluster, you MUST first run \`gcloud container clusters get-credentials <CLUSTER_NAME> --zone <ZONE>\` (or --region) to configure kubectl access. You MUST extract the cluster's ZONE or REGION from the initial \`list\` command.
        - **Namespacing:**
          - When running a command that can be namespaced (e.g., \`get pods\`, \`get services\`, \`describe deployment\`):
            - If the user provides a namespace, use it (e.g., \`--namespace <user_namespace>\`).
            - If the user does NOT provide a namespace, you MUST use the \`default\` namespace (e.g., \`kubectl get pods --namespace default\`). You must also state in your answer that you are showing results from the 'default' namespace.
          - **Cluster-Scoped Resources:** You must be aware that some resources are not namespaced (e.g., \`nodes\`, \`persistentvolumes\`, \`clusterroles\`). For these commands, you MUST NOT add a namespace flag. Do not fail if the user asks for these without a namespace.

        **5. Intelligent Error Analysis:**
        - When a command fails, do not just repeat the error message. Analyze it.
        - If a previous command for a service (e.g., BigQuery) worked, and a subsequent one fails, do NOT conclude the entire API is disabled. The error is likely with your specific command. Re-examine it for syntax errors, incorrect names, or permissions specific to that resource before answering.

        **6. BigQuery SQL Generation (\`bq query\`)**
        - When a user asks a question that requires querying data (e.g., "how many rows..."), you MUST use the \`bq query\` command.
        - You are to construct a standard SQL query string. To avoid shell errors, the entire SQL query string MUST be enclosed in **single quotes (\`'...'\`)**.
        - **Correct Example:** \`bq query --project_id <project> 'SELECT COUNT(*) FROM \`my-dataset.my-table\`'\`
        - **Important:** Do NOT use double quotes around the SQL query. It will cause a syntax error.
        - If the query is too complex (e.g., involves JOINs or window functions), you should respond that you can only handle simple SQL queries.`,
  ],
  new MessagesPlaceholder({ variableName: 'chat_history', optional: true }),
  ['human', '{input}'],
  new MessagesPlaceholder('agent_scratchpad'), // agent_scratchpad is now a placeholder for the new agent
]);

// --- 4. Set up the Express Server ---
const app = express();
app.use(cors());
app.use(express.json());

async function startServer() {
  // BUILD_MARKER: V15 - Definitive Fix for sign-url context
  console.log("[INDEX_LOG] Starting server with index.ts (V15)");
  // --- 3. Create the Agent and Executor (Updated to createToolCallingAgent) ---
  const agent = await createToolCallingAgent({ // CHANGED
    llm: model,
    tools,
    prompt,
  });

  const agentExecutor = new AgentExecutor({
    agent,
    tools,
    verbose: false, // This is the change you approved
  });

  // --- 5. Define the API Endpoint (Logic remains the same)---
  app.post('/api/gcloud', async (req: Request, res: Response) => {
    console.log(`--- NEW GCLOUD-BACKEND REQUEST ---`);
    console.log(`[REQUEST_BODY]: ${JSON.stringify(req.body)}`);

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.error('[AUTH_ERROR] Authorization header missing or invalid');
      return res
        .status(401)
        .json({ response: 'Authorization (Access Token) not provided or invalid' });
    }
    const userAccessToken = authHeader.split(' ')[1];

    const { prompt: userPrompt, history = [] } = req.body;
    if (!userPrompt) {
      console.error('[REQUEST_ERROR] Prompt not provided in request body');
      return res
        .status(400)
        .json({ response: 'Prompt not provided in the request body' });
    }

    try {
      console.log(`[AGENT_INPUT] Prompt: "${userPrompt}"`);
      const result = await agentExecutor.invoke(
        {
          input: userPrompt,
          chat_history: history.map((msg: HistoryMessage) =>
            msg.type === 'user'
              ? new HumanMessage(msg.content)
              : new AIMessage(msg.content)
          ) as BaseMessage[],
        },
        { configurable: { userAccessToken } }
      );

      console.log(`[AGENT_OUTPUT] Response: "${result.output}"`);
      res.json({ response: result.output });
    } catch (error: any) {
      console.error('[AGENT_EXECUTOR_ERROR]', error);
      if (error.message && error.message.includes('Could not parse LLM output')) {
        const match = error.message.match(/Could not parse LLM output: (.*)/);
        const readableError = match
          ? match[1]
          : 'Sorry, I encountered an unexpected error.';
        console.log(
          `[PARSING_ERROR_HANDLER] Caught parsing error. Sending readable response: "${readableError}"`
        );
        res.json({ response: readableError });
      } else {
        res
          .status(500)
          .json({ response: `An internal error occurred: ${error.message}` });
      }
    }
  });

  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`-> AgentUI REST endpoint available at /api/gcloud`);
  });
}

// Start the server
startServer();