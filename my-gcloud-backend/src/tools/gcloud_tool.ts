/**
 * Copyright 2025 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *	http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Tool } from "@langchain/core/tools";
import * as child_process from 'child_process';
import {
  AccessControlList,
  createAccessControlList,
} from '../denylist';
import * as gcloud from '../gcloud';
import type { RunnableConfig } from "@langchain/core/runnables";
import type { CallbackManagerForToolRun } from "@langchain/core/callbacks/manager";

let lastKnownProjectId = '';

const defaultDeny = [
  'sftp',
  'ssh',
  'docker',
  'gen-repo-info-file',
];

const accessControl = createAccessControlList([], defaultDeny);

class GoogleCloudSDK extends Tool {
    name = 'google-cloud-sdk';
    description = `Executes a command for a Google Cloud command-line interface: gcloud, gsutil, kubectl, or bq. Input should be the full command string.`;

    async _call(
      commandString: string,
      runManager?: CallbackManagerForToolRun,
      config?: RunnableConfig
    ): Promise<string> {
      // BUILD_MARKER: V29 - The REAL `bq` fix, derived from the user's -old file.
      console.log(`[GCLOUD_TOOL_LOG] Raw command string from agent: "${commandString}"`);

      const argRegex = /(?:[^\s\"\']+|\"[^\"]*\"|\'[^\']*\')+/g;
      const rawArgs = commandString.match(argRegex) || [];
      if (rawArgs.length === 0) {
          return "Error: Invalid command. The command string cannot be empty.";
      }
      const [tool, ...args] = rawArgs.map(arg => arg.replace(/^['\"]|['\"]$/g, ''));

      if (!["gcloud", "gsutil", "kubectl", "bq"].includes(tool)) {
        return `Error: Invalid tool '${tool}'. The first word of the command must be one of gcloud, gsutil, kubectl, or bq.`;
      }

      const userAccessToken = config?.configurable?.userAccessToken;
      if (!userAccessToken) {
        return "Error: User access token is missing. Cannot authenticate.";
      }

      // Simple project ID parsing
      const projectFlag = args.find(arg => arg.startsWith('--project') || arg.startsWith('--project_id'));
      let projectId = projectFlag ? projectFlag.split('=')[1] : undefined;
      if (projectId) {
        // Clean up quotes from the parsed project ID
        projectId = projectId.replace(/^["|']|["|']$/g, "");
      }
      if (!projectId) {
          const projectIndex = args.indexOf('--project') + 1;
          if (projectIndex > 0 && projectIndex < args.length) {
              projectId = args[projectIndex];
          }
          const projectIdIndex = args.indexOf('--project_id') + 1;
          if (projectIdIndex > 0 && projectIdIndex < args.length) {
              projectId = args[projectIdIndex];
          }
      }

      if (projectId) {
        lastKnownProjectId = projectId;
        console.log(`[GCLOUD_TOOL] Project ID for this operation: ${projectId}`);
      } else if(lastKnownProjectId) {
        console.log(`[GCLOUD_TOOL] Using last known Project ID: ${lastKnownProjectId}`);
        projectId = lastKnownProjectId;
      }
      
      const env = { ...process.env };
      
      const isSignUrlCommand = commandString.includes('gcloud storage sign-url');
      if (isSignUrlCommand) {
        console.log('[GCLOUD_TOOL] Impersonation bypassed for sign-url. Using application default credentials.');
      } else {
        console.log('[GCLOUD_TOOL] Impersonation active: Setting CLOUDSDK_AUTH_ACCESS_TOKEN in environment.');
        env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = userAccessToken;
      }

      if(projectId) env['CLOUDSDK_CORE_PROJECT'] = projectId;

      const accessControlResult = accessControl.check(commandString);
      if (accessControlResult.permitted === false) {
        return accessControlResult.message;
      }
    
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let child;

        // This is the surgical fix that implements your request.
        // It detects the single failing pattern and handles it differently,
        // leaving all other working commands completely unchanged.

        // 1. Define a flag to identify ONLY the failing case: a sign-url command
        //    that contains a quoted gs:// path (which implies spaces).
        const isSignUrlWithSpaces = 
            commandString.includes('gcloud storage sign-url') && 
            commandString.includes('"gs://');

        // 2. Check the flag.
        if (isSignUrlWithSpaces) {
            // 3. IF it's the failing case, run the command without a shell.
            //    This is the standard, safe method that correctly handles arguments
            //    with spaces (like the quoted gs:// path) because it passes them
            //    as a clean list, avoiding any shell confusion.
            console.log('[GCLOUD_TOOL] Detected sign-url with spaces. Using direct execution (no shell).');
            child = child_process.spawn(tool, args, { env, shell: false });
        } else {
            // 4. FOR EVERYTHING ELSE (bq query, normal gcloud, sign-url without spaces),
            //    use the existing method that you've confirmed is working.
            //    This ensures those commands are not affected.
            console.log('[GCLOUD_TOOL] Using shell execution.');
            child = child_process.spawn(commandString, { env, shell: true });
        }
    
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
    
        child.on('close', (code) => {
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Command: '${commandString}'`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Exit Code: ${code}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDOUT: ${stdout}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDERR: ${stderr}`);

          if (code === 0) {
            
            if (isSignUrlCommand) {
                // This logic is from your approved version to format the URL.
                const urlMatch = stdout.match(/^signed_url:\s*(https:\/\/.*)/m);
                if (urlMatch && urlMatch[1]) {
                    const url = urlMatch[1].trim();

                    const gsPath = args.find(arg => arg.startsWith('gs://'));
                    let filename = 'file'; 
                    if (gsPath) {
                        const parts = gsPath.split('/');
                        const lastPart = parts[parts.length - 1];
                        if (lastPart) { 
                            filename = lastPart;
                        }
                    }

                    resolve(`[Download ${filename}](${url})`);
                } else {
                    resolve('Command executed successfully, but failed to extract the signed URL from the output.');
                }
            } else if (stdout.trim() === '') {
                resolve("Command executed successfully and returned no output.");
            } else {
                resolve(stdout);
            }
          } else {
            resolve(`Error: Command failed with exit code ${code}. Stderr: ${stderr}`);
          }
        });
    
        child.on('error', (err) => {
          resolve(`Failed to start the process: ${err.message}`);
        });
      });
    }
}

export const googleCloudSdkTool = new GoogleCloudSDK();