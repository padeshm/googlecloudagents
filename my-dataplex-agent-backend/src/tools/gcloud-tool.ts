
import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";

/**
 * Executes a gcloud command-line (gcloud CLI) command.
 * The toolInput is now treated as the raw command string, which is what the agent is providing.
 */
async function runGcloudCliCommand(command: string): Promise<string> {
  // No more JSON parsing. The input string is the command.
  console.log(`\n🤖 Executing gcloud CLI command: gcloud ${command}\n`);

  // A simple validation to prevent accidental execution of malformed inputs.
  if (!command || typeof command !== 'string' || command.includes('{')) {
    return `Error: Invalid command format received. The gcloud_cli_tool expects a plain command string, but received: ${command}`;
  }

  return new Promise((resolve, reject) => {
    exec(`gcloud ${command}`, (error, stdout, stderr) => {
      if (error) {
        const errorMessage = `Error executing gcloud command: ${error.message}\nStderr: ${stderr}`;
        console.error(errorMessage);
        reject(errorMessage);
        return;
      }

      if (stderr && !stdout) {
        console.warn(`gcloud command produced a warning on stderr: ${stderr}`);
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
    Executes Google Cloud (gcloud) commands.
    The input MUST be the command string to execute, without the 'gcloud' prefix.
    Example: "dataplex datascans list --project=my-project-id --location=us-central1"
  `,
  // The function now correctly accepts a string and treats it as a direct command.
  func: runGcloudCliCommand,
});
