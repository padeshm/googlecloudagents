
import { exec } from 'child_process';
import { DynamicTool } from "@langchain/core/tools";

/**
 * The agent passes a string that CONTAINS JSON. We must parse it to get the command.
 * This function correctly handles that specific input format.
 */
async function runGcloudCliCommand(toolInput: string): Promise<string> {
  let command = '';

  try {
    // The input is a stringified JSON object like '{"input":"gcloud command..."}'.
    // We must parse it to extract the actual command.
    const parsedInput = JSON.parse(toolInput);
    command = parsedInput.input;

    if (!command) {
      throw new Error("The 'input' key was not found in the parsed JSON.");
    }

  } catch (e) {
    // If parsing fails, it means the input format was not the expected stringified JSON.
    // This is a fallback to prevent a crash and to provide a clear error to the agent.
    const errorMessage = `FATAL: Tool received an input that was not a valid stringified JSON object with an 'input' key. Input was: ${toolInput}`;
    console.error(errorMessage);
    return errorMessage;
  }

  console.log(`\n🤖 EXECUTING FINAL COMMAND: gcloud ${command}\n`);

  return new Promise((resolve, reject) => {
    exec(`gcloud ${command}`, (error, stdout, stderr) => {
      if (error) {
        const errorMessage = `Error executing gcloud command: ${error.message}\nStderr: ${stderr}`;
        console.error(errorMessage);
        // Reject so the agent knows the tool itself failed.
        reject(errorMessage);
        return;
      }

      if (stderr && !stdout) {
        console.warn(`gcloud command produced a warning or non-fatal error on stderr: ${stderr}`);
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
    The input to this tool MUST be a stringified JSON object with an 'input' key containing the command.
    Example: '{"input": "dataplex datascans list --project=my-project-id"}'
  `,
  func: runGcloudCliCommand,
});
