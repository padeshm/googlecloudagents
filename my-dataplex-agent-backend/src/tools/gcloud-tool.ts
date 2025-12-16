
import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";
import { RunnableConfig } from '@langchain/core/runnables';

/**
 * Executes a gcloud command using the end-user's access token for authentication.
 * The function now accepts the config object to access the token.
 */
async function runGcloudCliCommand(command: string, config?: RunnableConfig): Promise<string> {
  console.log(`\n🤖 Tool received command: gcloud ${command}`);

  // Extract the user's access token passed from the agent executor
  const userAccessToken = config?.configurable?.userAccessToken;

  if (!userAccessToken) {
    const errorMsg = "Authentication Error: User access token not found. The tool cannot execute gcloud commands without it.";
    console.error(errorMsg);
    return errorMsg;
  }

  return new Promise((resolve) => {
    exec(`gcloud ${command}`, {
      // Set the environment variable for the gcloud command.
      // gcloud will automatically use this token for authentication.
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
  func: runGcloudCliCommand,
});
