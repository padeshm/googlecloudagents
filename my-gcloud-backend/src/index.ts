import express, { Request, Response } from 'express';
import cors from 'cors';
import { ChatVertexAI } from '@langchain/google-vertexai';
import { AgentExecutor, createReactAgent } from 'langchain/agents';
import { ChatPromptTemplate, MessagesPlaceholder } from '@langchain/core/prompts';
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { googleCloudSdkTool } from './tools/gcloud_tool';

// Define the shape of the history messages for type safety
interface HistoryMessage {
    type: 'user' | 'ai';
    content: string;
}

// --- 1. Initialize Model and Tools ---
const model = new ChatVertexAI({
    model: 'gemini-2.5-pro',
    temperature: 0,
});

const tools = [googleCloudSdkTool];

// --- 2. Create the Agent Prompt ---
const prompt = ChatPromptTemplate.fromMessages([
    [
        'system',
        `You are a helpful assistant who is an expert in Google Cloud. You have access to a tool that can execute Google Cloud command-line interface commands (gcloud, gsutil, kubectl, bq). 
        When a user asks for an action, use this tool to fulfill their request.
        
        TOOLS:
        ------
        Here are the tools you can use:
        
        {tools}
        
        Use the following format:
        
        Question: the input question you must answer
        Thought: you should always think about what to do
        Action: the action to take, should be one of [{tool_names}]
        Action Input: the input to the action
        Observation: the result of the action
        ... (this Thought/Action/Action Input/Observation can repeat N times)
        Thought: I now know the final answer
        Final Answer: the final answer to the original input question
        
        When you have a response to say to the Human, or if you do not need to use a tool, you MUST use the format:
        \`\`\`
        Thought: I now know the final answer
        Final Answer: [your response]
        \`\`\``,
    ],
    new MessagesPlaceholder({ variableName: 'chat_history', optional: true }),
    // The human input now includes the agent_scratchpad placeholder. This is the
    // correct format for the ReAct agent, which expects the scratchpad as a string.
    ['human', '{input}\n\n{agent_scratchpad}'],
]);

// --- 4. Set up the Express Server ---
const app = express();
app.use(cors());
app.use(express.json());

// We must wrap the agent creation and server startup in an async function
// to correctly handle the promise returned by createReactAgent.
async function startServer() {
    // --- 3. Create the Agent and Executor ---
    const agent = await createReactAgent({
        llm: model,
        tools,
        prompt
    });

    const agentExecutor = new AgentExecutor({
        agent,
        tools,
        verbose: false // This is the change you approved
    });

    // --- 5. Define the API Endpoint ---
    app.post('/api/gcloud', async (req: Request, res: Response) => {
        console.log(`--- NEW GCLOUD-BACKEND REQUEST ---`);
        console.log(`[REQUEST_BODY]: ${JSON.stringify(req.body)}`);

        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.error('[AUTH_ERROR] Authorization header missing or invalid');
            return res.status(401).json({ response: 'Authorization (Access Token) not provided or invalid' });
        }
        const userAccessToken = authHeader.split(' ')[1];

        const { prompt: userPrompt, history = [] } = req.body;
        if (!userPrompt) {
            console.error('[REQUEST_ERROR] Prompt not provided in request body');
            return res.status(400).json({ response: 'Prompt not provided in the request body' });
        }

        try {
            console.log(`[AGENT_INPUT] Prompt: "${userPrompt}"`);
            // The AgentExecutor now handles the entire conversation flow.
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

        } catch (error: any) { // Type the error to access its properties
            console.error("[AGENT_EXECUTOR_ERROR]", error);
            // Check for the specific parsing error
            if (error.message && error.message.includes("Could not parse LLM output")) {
                // Extract the human-readable part of the error
                const match = error.message.match(/Could not parse LLM output: (.*)/);
                const readableError = match ? match[1] : "Sorry, I encountered an unexpected error.";
                console.log(`[PARSING_ERROR_HANDLER] Caught parsing error. Sending readable response: "${readableError}"`);
                res.json({ response: readableError });
            } else {
                res.status(500).json({ response: `An internal error occurred: ${error.message}` });
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
