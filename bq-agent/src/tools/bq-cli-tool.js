
import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";

/**
 * Executes a BigQuery command-line (bq) command with impersonation.
 * @param {string} inputString The stringified JSON input from the agent.
 * @param {import("@langchain/core/callbacks/manager").CallbackManagerForToolRun} [runManager] Optional run manager from LangChain.
 * @param {import("@langchain/core/runnables").RunnableConfig} [config] Optional config from LangChain.
 * @returns {Promise<string>} A promise that resolves to the stdout of the command, or an error message.
 */
async function runBqCliCommand(inputString, runManager, config) {
  try {
    // THE CRITICAL FIX: Parse the stringified JSON input from the agent
    const toolInput = JSON.parse(inputString);
    const command = toolInput.input;

    console.log(`\n🤖 Executing bq CLI command: bq ${command}`);

    const userAccessToken = config?.configurable?.userAccessToken;

    if (!userAccessToken) {
      const errorMsg = "Authentication Error: User access token not found.";
      console.error(errorMsg);
      return errorMsg;
    }

    return new Promise((resolve) => {
      exec(`bq ${command}`,
        {
          env: {
            ...process.env,
            CLOUDSDK_AUTH_ACCESS_TOKEN: userAccessToken,
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            const errorMessage = `Execution Error: ${error.message}\nStderr: ${stderr}`;
            console.error(errorMessage);
            resolve(errorMessage);
            return;
          }
          if (stderr && !stdout) {
            console.warn(`bq command returned stderr: ${stderr}`);
            resolve(stderr.trim());
            return;
          }
          resolve(stdout.trim());
        }
      );
    });
  } catch (e) {
      const errorMessage = `Tool Error: Failed to parse input string: ${inputString}. Error: ${e.message}`;
      console.error(errorMessage);
      return errorMessage;
  }
}

export const bqCliTool = new DynamicTool({
  name: "bq_cli_tool",
  description: `
    Executes BigQuery command-line (bq) commands for metadata tasks like listing datasets/tables or getting schema.
    The input MUST be a valid 'bq' command string, WITHOUT the 'bq' prefix.
    Example: To list datasets, input "ls --project_id=my-project".
  `,
  func: runBqCliCommand,
});
