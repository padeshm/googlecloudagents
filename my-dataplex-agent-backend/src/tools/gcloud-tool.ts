import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";
import { RunnableConfig } from '@langchain/core/runnables';
import { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";

/**
 * Executes a Google Cloud SDK command (gcloud, bq, gsutil) using the end-user's access token.
 */
async function runGoogleCloudSdkCommand(
  command: string,
  runManager?: CallbackManagerForToolRun,
  config?: RunnableConfig
): Promise<string> {
  // The tool now logs the full command as received.
  console.log(`
🤖 Tool received command: ${command}`);

  const userAccessToken = config?.configurable?.userAccessToken;

  if (!userAccessToken) {
    const errorMsg = "Authentication Error: User access token was not found in the tool's config. This is required for SDK commands.";
    console.error(errorMsg);
    return errorMsg;
  }

  // The 'gcloud' prefix is removed. The command is now executed as-is.
  return new Promise((resolve) => {
    exec(command, {
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
        const stderrMessage = `Command may have produced a warning or non-fatal error. Stderr: ${stderr}`;
        console.warn(stderrMessage);
        resolve(stderr.trim());
        return;
      }
      console.log(`Command successful, stdout:\n${stdout}`);
      resolve(stdout.trim());
    });
  });
}

export const googleCloudSdkTool = new DynamicTool({
  // The tool has been renamed to be more generic.
  name: "google_cloud_sdk_tool",
  // The description now tells the agent it can handle gcloud, bq, and gsutil.
  // It also instructs the agent to provide the *entire* command.
  description: `
    Executes Google Cloud SDK commands (gcloud, bq, gsutil) on behalf of the user.
    The input MUST be a plain string containing the full command to execute, including the tool name (e.g., 'gcloud', 'bq', 'gsutil').
    Example: "gcloud dataplex datascans list --project=my-project-id"
    Example: "bq show --schema --format=prettyjson my-project-id:my_dataset.my_table"
  `,
  func: runGoogleCloudSdkCommand,
});
