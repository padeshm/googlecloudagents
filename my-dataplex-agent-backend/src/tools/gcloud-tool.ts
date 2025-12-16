
import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";
import { RunnableConfig } from '@langchain/core/runnables';
// This import is required to correctly type the function signature for the tool.
import { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";

/**
 * Executes a gcloud command using the end-user's access token.
 * The function signature now correctly matches the one expected by DynamicTool,
 * including the optional 'runManager' as the second argument.
 */
async function runGcloudCliCommand(
  command: string,
  // The runManager is passed by the agent but is not used in this tool.
  // It is included here to ensure the function signature is correct.
  runManager?: CallbackManagerForToolRun,
  // The config object, containing the access token, is now correctly the third parameter.
  config?: RunnableConfig
): Promise<string> {
  console.log(`\n🤖 Tool received command: gcloud ${command}`);

  const userAccessToken = config?.configurable?.userAccessToken;

  if (!userAccessToken) {
    const errorMsg = "Authentication Error: User access token was not found in the tool's config. This is required for gcloud commands.";
    console.error(errorMsg);
    return errorMsg;
  }

  return new Promise((resolve) => {
    exec(`gcloud ${command}`, {
      env: {
        ...process.env,
        CLOUDSDK_AUTH_ACCESS_TOKEN: userAccessToken,
      },
    }, (error, stdout, stderr) => {
      if (error) {
        const errorMessage = `Execution Error: ${error.message}\nStderr: ${stderr}`;
        console.error(errorMessage);
        resolve(errorMessage);
        return;
      }
      if (stderr && !stdout) {
        const stderrMessage = `Command may have failed. Stderr: ${stderr}`;
        console.warn(stderrMessage);
        resolve(stderr.trim());
        return;
      }
      console.log(`gcloud command successful, stdout:\n${stdout}`);
      resolve(stdout.trim());
    });
  });
}

export const gcloudTool = new DynamicTool({
  name: "gcloud_cli_tool",
  description: `
    Executes Google Cloud (gcloud) commands on behalf of the user.
    The input MUST be a plain string containing the command to execute (without the 'gcloud' prefix).
    Example: "dataplex datascans list --project=my-project-id"
  `,
  // The function now has the correct signature that DynamicTool expects.
  func: runGcloudCliCommand,
});
