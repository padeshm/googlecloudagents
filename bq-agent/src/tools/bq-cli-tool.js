
import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";

/**
 * Executes a BigQuery command-line (bq) command with impersonation.
 * @param {{input: string}} toolInput The tool input object, containing the command string.
 * @param {import("@langchain/core/callbacks/manager").CallbackManagerForToolRun} [runManager] Optional run manager from LangChain.
 * @param {import("@langchain/core/runnables").RunnableConfig} [config] Optional config from LangChain, which should contain the user's access token.
 * @returns {Promise<string>} A promise that resolves to the stdout of the command, or an error message.
 */
async function runBqCliCommand(toolInput, runManager, config) {
  const command = toolInput.input; // Destructure the command string from the input object
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
