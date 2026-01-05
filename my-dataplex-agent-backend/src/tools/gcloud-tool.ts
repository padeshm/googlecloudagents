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
  console.log(`
🤖 Tool received command: gcloud ${command}`);

  const userAccessToken = config?.configurable?.userAccessToken;

  if (!userAccessToken) {
    const errorMsg = "Authentication Error: User access token was not found in the tool's config. This is required for SDK commands.";
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
  name: "google_cloud_sdk_tool",
  description: `
    Executes Google Cloud SDK commands (gcloud, bq, gsutil) on behalf of the user.
    The input MUST be a plain string containing the command to execute, but WITHOUT the 'gcloud' prefix.
    The tool will automatically prepend 'gcloud' to the command.
    Example for bq: "bq show --schema --format=prettyjson my-project-id:my_dataset.my_table"
    Example for gcloud: "dataplex datascans list --project=my-project-id"
  `,
  func: runGoogleCloudSdkCommand,
});
