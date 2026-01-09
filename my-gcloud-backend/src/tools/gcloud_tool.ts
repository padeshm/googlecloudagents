import { DynamicTool } from '@langchain/core/tools';
import { spawn } from 'child_process';
import { RunnableConfig } from '@langchain/core/runnables';
import { CallbackManagerForToolRun } from '@langchain/core/callbacks/manager';

// Define the shape of the input object for the tool for strict type checking.
interface GoogleCloudSdkInput {
    tool: 'gcloud' | 'gsutil' | 'kubectl' | 'bq';
    args: string[];
}

// This function executes a Google Cloud SDK command. It is designed to be called by a LangChain agent.
const runGoogleCloudSdkCommand = async (
    inputStr: string, 
    runManager?: CallbackManagerForToolRun, 
    config?: RunnableConfig
): Promise<string> => {
  let input: GoogleCloudSdkInput;
  try {
    // The agent passes a JSON string, so we need to parse it first.
    input = JSON.parse(inputStr);
  } catch (error: any) {
    return `Error: Invalid input format. Expected a valid JSON string. Details: ${error.message}`;
  }

  const { tool, args } = input;

  // The agent framework passes an impersonated access token via the configurable context.
  const accessToken = config?.configurable?.accessToken;

  // If the token is missing, we cannot proceed. This is a critical security check.
  if (!accessToken) {
    return 'Error: Authentication token not found in the execution context. This tool cannot be run.';
  }

  return new Promise((resolve) => {
    const executablePath = `/usr/bin/${tool}`;
    const fullCommand = `${tool} ${args.join(' ')}`;

    // Set up the environment for the child process.
    const env: { [key: string]: string | undefined } = {
        ...process.env,
        CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    };

    // Set the access token for authentication. This tells gcloud to use the provided token.
    // The `gcloud storage sign-url` command uses a different authentication flow and does not
    // work with this environment variable, so we exclude it.
    if (!fullCommand.includes('storage sign-url')) {
        env.CLOUDSDK_AUTH_ACCESS_TOKEN = accessToken;
    }

    const child = spawn(executablePath, args, { env: env as any });

    let output = '';
    let error = '';
    child.stdout.on('data', (data) => (output += data.toString()));
    child.stderr.on('data', (data) => (error += data.toString()));

    child.on('close', (code) => {
      if (code !== 0) {
        // On error, return the stderr for the agent to analyze.
        resolve(`Command failed with exit code ${code}. Stderr: ${error}`);
      } else {
        // On success, return the stdout.
        resolve(output);
      }
    });

    // Handle errors where the process itself fails to start.
    child.on('error', (err) => {
      resolve(`Failed to start the ${tool} process: ${err.message}`);
    });
  });
};

export const googleCloudSdkTool = new DynamicTool({
  name: 'google_cloud_sdk',
  description: `
      Executes a command for a Google Cloud command-line interface: gcloud, gsutil, kubectl, or bq.
      The input must be a JSON string with two keys: 'tool' and 'args'.
      The 'tool' key must be one of 'gcloud', 'gsutil', 'kubectl', or 'bq'.
      The 'args' key must be an array of strings representing the command's arguments.
      Example: To run 'gcloud compute instances list', the input should be '{"tool":"gcloud","args":["compute","instances","list"]}'.
  `,
  func: runGoogleCloudSdkCommand,
});
