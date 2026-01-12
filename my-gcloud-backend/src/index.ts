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

// --- 2. Create the Agent Prompt (Updated for the new agent type) ---
const prompt = ChatPromptTemplate.fromMessages([
  [
    'system',
    `You are a helpful assistant who is an expert in Google Cloud. You have access to a tool that can execute Google Cloud command-line interface commands (gcloud, gsutil, kubectl, bq). 
        When a user asks for an action, use this tool to fulfill their request.

        **CRITICAL INSTRUCTION**: After you have an Observation from a tool, you MUST either respond with a Final Answer OR another Action. You MUST NOT include both a Final Answer and an Action in the same response.`,
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
  // BUILD_MARKER: V3
  console.log("[INDEX_LOG] Starting server with index.ts (V3)");
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
// Triggering a rebuild
startServer();
