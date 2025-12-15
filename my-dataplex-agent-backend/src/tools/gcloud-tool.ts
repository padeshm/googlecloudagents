
import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";

// This interface defines the structure of the JSON object *inside* the string
// that the tool will receive.
interface GcloudToolArgs {
    input: string;
}

/**
 * Executes a gcloud command-line (gcloud CLI) command.
 * The 'toolInput' is a stringified JSON object that we need to parse first.
 */
async function runGcloudCliCommand(toolInput: string): Promise<string> {
  try {
    // The agent provides a JSON string, so we must parse it to get the object.
    const args: GcloudToolArgs = JSON.parse(toolInput);
    const command = args.input;

    console.log(`\n🤖 Executing gcloud CLI command: gcloud ${command}\n`);

    return new Promise((resolve, reject) => {
      exec(`gcloud ${command}`, (error, stdout, stderr) => {
        if (error) {
          const errorMessage = `Error executing gcloud command: ${error.message}\nStderr: ${stderr}`;
          console.error(errorMessage);
          reject(errorMessage);
          return;
        }

        if (stderr && !stdout) {
          console.warn(`gcloud command produced a warning or error on stderr: ${stderr}`);
          resolve(stderr.trim());
          return;
        }

        console.log(`gcloud command successful, stdout:\n${stdout}`);
        resolve(stdout.trim());
      });
    });
  } catch (e: any) {
      return `Error: The input to the gcloud_cli_tool was not valid JSON. Please provide a valid JSON object with an 'input' key. Input: ${toolInput}`;
  }
}

export const gcloudTool = new DynamicTool({
  name: "gcloud_cli_tool",
  description: `
    Useful for executing Google Cloud (gcloud) commands. 
    The input to this tool MUST be a stringified JSON object with an 'input' key.
    Example: '{"input": "dataplex datascans list --project=my-project-id"}'
  `,
  // The function now correctly accepts a string, satisfying the DynamicTool's type requirement.
  func: runGcloudCliCommand,
});
