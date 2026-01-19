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
      console.log(`[GCLOUD_TOOL_LOG] Raw command string from agent: "${commandString}"`);

      const argRegex = /(?:[^\s"\']+|\"[^\"]*\"|\'[^\']*\')+/g;
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
      
      if(projectId) env['CLOUDSDK_CORE_PROJECT'] = projectId;

      // The bq tool does not reliably use the CLOUDSDK_AUTH_ACCESS_TOKEN env var.
      // Instead, we must pass the token as a flag directly to the command.
      if (tool === 'bq') {
        args.unshift('--access_token', userAccessToken);
      } else {
        env['CLOUDSDK_AUTH_ACCESS_TOKEN'] = userAccessToken;
      }
      const accessControlResult = accessControl.check(args.join(' '));
      if (accessControlResult.permitted === false) {
        return accessControlResult.message;
      }
    
      return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';

        const child = child_process.spawn(tool, args, { env, shell: false });
    
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
    
        child.on('close', (code) => {
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Command: '${tool} ${args.join(' ')}'`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] Exit Code: ${code}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDOUT: ${stdout}`);
          console.log(`[GCLOUD_TOOL_DIAGNOSTICS] STDERR: ${stderr}`);

          if (code === 0) {
            const isSignUrl = tool === 'gcloud' && args.includes('storage') && args.includes('sign-url');
            if (isSignUrl) {
                const urlMatch = stdout.match(/^signed_url:\s*(https:\/\/.*)/m);
                if (urlMatch && urlMatch[1]) {
                    resolve(urlMatch[1].trim());
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
          resolve(`Failed to start the ${tool} process: ${err.message}`);
        });
      });
    }
}

export const googleCloudSdkTool = new GoogleCloudSDK();