
import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";

// Defines the structure of the object the LLM will pass to our tool.
interface GcloudToolArgs {
    input: string;
}

/**
 * Executes a gcloud command-line (gcloud CLI) command.
 * The input is now an object containing the command string.
 */
async function runGcloudCliCommand(args: GcloudToolArgs): Promise<string> {
  // Extract the actual command from the 'input' property.
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
}

export const gcloudTool = new DynamicTool({
  name: "gcloud_cli_tool",
  description: `
    Useful for executing Google Cloud (gcloud) commands to manage and get metadata about cloud resources.
    The input to this tool MUST be a JSON object with an 'input' key containing the command string to execute.
    Example: { "input": "dataplex datascans list --project=my-project-id --location=us-central1" } 
  `,
  func: runGcloudCliCommand,
});
