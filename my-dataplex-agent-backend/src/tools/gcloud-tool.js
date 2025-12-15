import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";

/**
 * Executes a gcloud command-line (gcloud CLI) command.
 * @param {string} command - The gcloud CLI command to execute (e.g., "dataplex datascans list --project=my-project").
 * @returns {Promise<string>} A promise that resolves to the stdout of the command, or an error message.
 */
async function runGcloudCliCommand(command) {
  console.log(`\n🤖 Executing gcloud CLI command: gcloud ${command}\n`);
  return new Promise((resolve, reject) => {
    // The `gcloud` command is expected to be in the PATH of the environment.
    exec(`gcloud ${command}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`ERROR executing gcloud command: ${error.message}`);
        // Return both the error message and stderr for the agent to have more context
        reject(`Error executing gcloud command: ${error.message}\nStderr: ${stderr}`);
        return;
      }
      if (stderr && !stdout) {
        // Sometimes gcloud prints warnings or non-fatal errors to stderr
        console.warn(`WARN from gcloud command: ${stderr}`);
        resolve(stderr.trim());
      }
      resolve(stdout.trim()); // Trim to remove any leading/trailing whitespace
    });
  });
}

export const gcloudTool = new DynamicTool({
  name: "gcloud_cli_tool",
  description: `
    Useful for executing Google Cloud (gcloud) commands to manage and get metadata about cloud resources.
    Use this for all interactions with Google Cloud services that have a gcloud command, especially Dataplex.
    - **Listing Dataplex data scans:** (e.g., input: "dataplex datascans list --project=my-project-id --location=us-central1").
    - **Describing a Dataplex data scan:** (e.g., input: "dataplex datascans describe my-scan-id --project=my-project-id --location=us-central1").
    The input to this tool MUST be a valid 'gcloud' command string, WITHOUT the 'gcloud' prefix.
  `,
  func: runGcloudCliCommand,
});
