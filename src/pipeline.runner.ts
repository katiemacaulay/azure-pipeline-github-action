import * as core from '@actions/core';
import * as azdev from "azure-devops-node-api";
import { TaskParameters } from './task.parameters';
import { PipelineNotFoundError } from './pipeline.error';

import * as ReleaseInterfaces from 'azure-devops-node-api/interfaces/ReleaseInterfaces';
import * as BuildInterfaces from 'azure-devops-node-api/interfaces/BuildInterfaces';
import { PipelineHelper as p } from './util/pipeline.helper';
import { Logger as log } from './util/logger';
import { UrlParser } from './util/url.parser';

export class PipelineRunner {
    public taskParameters: TaskParameters;
    readonly repository = p.processEnv("GITHUB_REPOSITORY");
    readonly branch = p.processEnv("GITHUB_REF");
    readonly commitId = p.processEnv("GITHUB_SHA");
    readonly githubRepo = "GitHub";

    constructor(taskParameters: TaskParameters) {
        this.taskParameters = taskParameters
    }

    private getGithubBranchName(): string {
        // GITHUB_REF comes in format like "refs/heads/main" or "refs/heads/feature-branch"
        // We need to extract just the branch name
        if (this.branch && this.branch.startsWith('refs/heads/')) {
            return this.branch.replace('refs/heads/', '');
        }
        // Fallback for other ref types or if format is unexpected
        return this.branch;
    }

    private formatBranchForAzureDevOps(branchName: string): string {
        // Try without refs/heads/ prefix first - some Azure DevOps configurations prefer this
        if (branchName && branchName.startsWith('refs/heads/')) {
            return branchName.replace('refs/heads/', '');
        }
        return branchName;
    }

    public async start(): Promise<any> {
        try {
            var taskParams = TaskParameters.getTaskParams();
            
            // Debug branch parameter values
            core.info(`=== Branch Debug Info ===`);
            core.info(`Input azure-pipeline-branch: "${this.taskParameters.azurePipelineBranch}"`);
            core.info(`GitHub GITHUB_REF: "${this.branch}"`);
            core.info(`GitHub repository: "${this.repository}"`);
            core.info(`Extracted GitHub branch: "${this.getGithubBranchName()}"`);
            core.info(`========================`);
            
            let authHandler = azdev.getPersonalAccessTokenHandler(taskParams.azureDevopsToken);
            let collectionUrl = UrlParser.GetCollectionUrlBase(this.taskParameters.azureDevopsProjectUrl);
            core.info(`Creating connection with Azure DevOps service : "${collectionUrl}"`)
            let webApi = new azdev.WebApi(collectionUrl, authHandler);
            core.info("Connection created");

            let pipelineName = this.taskParameters.azurePipelineName;
            try {
                core.debug(`Triggering Yaml pipeline : "${pipelineName}"`);
                await this.RunYamlPipeline(webApi);
            }
            catch (error) {
                if (error instanceof PipelineNotFoundError) {
                    core.debug(`Triggering Designer pipeline : "${pipelineName}"`);
                    await this.RunDesignerPipeline(webApi);
                } else {
                    throw error;
                }
            }
        } catch (error) {
            let errorMessage: string = `${error.message}`;
            core.setFailed(errorMessage);
        }
    }

    public async RunYamlPipeline(webApi: azdev.WebApi): Promise<any> {
        let projectName = UrlParser.GetProjectName(this.taskParameters.azureDevopsProjectUrl);
        let pipelineName = this.taskParameters.azurePipelineName;
        let buildApi = await webApi.getBuildApi();

        // Get matching build definitions for the given project and pipeline name
        const buildDefinitions = await buildApi.getDefinitions(projectName, pipelineName);

        p.EnsureValidPipeline(projectName, pipelineName, buildDefinitions);

        // Extract Id from build definition
        let buildDefinitionReference: BuildInterfaces.BuildDefinitionReference = buildDefinitions[0];
        let buildDefinitionId = buildDefinitionReference.id;

        // Get build definition for the matching definition Id
        let buildDefinition = await buildApi.getDefinition(projectName, buildDefinitionId);

        log.LogPipelineObject(buildDefinition);

        // Fetch repository details from build definition
        let repositoryId = buildDefinition.repository.id.trim();
        let repositoryType = buildDefinition.repository.type.trim();
        let sourceBranch = null;
        let sourceVersion = null;

        // Debug repository matching
        core.info(`=== Repository Matching Debug ===`);
        core.info(`Pipeline repository ID: "${repositoryId}"`);
        core.info(`GitHub repository: "${this.repository}"`);
        core.info(`Pipeline repository type: "${repositoryType}"`);
        core.info(`Expected type: "${this.githubRepo}"`);
        core.info(`Repository ID match: ${p.equals(repositoryId, this.repository)}`);
        core.info(`Repository type match: ${p.equals(repositoryType, this.githubRepo)}`);
        core.info(`================================`);

        // If definition is linked to existing github repo, pass github source branch and source version to build
        if (p.equals(repositoryId, this.repository) && p.equals(repositoryType, this.githubRepo)) {
            core.debug("pipeline is linked to same Github repo");
            // Use custom branch if provided, otherwise use current GitHub branch
            let targetBranchName = this.taskParameters.azurePipelineBranch || this.getGithubBranchName();
            let targetBranch = this.formatBranchForAzureDevOps(targetBranchName);
            core.info(`Final target branch for Azure DevOps: ${targetBranch}`);
            core.debug(`Original branch input: ${this.taskParameters.azurePipelineBranch}`);
            core.debug(`GitHub ref: ${this.branch}`);
            sourceBranch = targetBranch;
            sourceVersion = this.commitId;
        } else if (this.taskParameters.azurePipelineBranch) {
            // If custom branch is specified but repo doesn't match, still try to use the custom branch
            core.info("Pipeline is not linked to same Github repo, but custom branch specified");
            let targetBranch = this.formatBranchForAzureDevOps(this.taskParameters.azurePipelineBranch);
            core.info(`Using custom branch for non-GitHub pipeline: ${targetBranch}`);
            sourceBranch = targetBranch;
            // Don't set sourceVersion for non-GitHub repos as it may not be compatible
        } else {
            core.debug("pipeline is not linked to same Github repo");
        }

        let build: BuildInterfaces.Build = {
            definition: {
                id: buildDefinition.id
            },
            project: {
                id: buildDefinition.project.id
            },
            sourceBranch: sourceBranch,
            sourceVersion: sourceVersion,
            reason: BuildInterfaces.BuildReason.Triggered,
            parameters: this.taskParameters.azurePipelineVariables,
            // Explicitly set repository information to ensure branch is respected
            repository: sourceBranch ? {
                id: repositoryId,
                type: repositoryType
            } : undefined
        } as BuildInterfaces.Build;

        // Debug the complete build object being sent
        core.info(`=== Build Object Debug ===`);
        core.info(`Definition ID: ${build.definition.id}`);
        core.info(`Project ID: ${build.project.id}`);
        core.info(`Source Branch: "${build.sourceBranch}"`);
        core.info(`Source Version: "${build.sourceVersion}"`);
        core.info(`Reason: ${build.reason}`);
        core.info(`Parameters: ${build.parameters || 'undefined'}`);
        core.info(`========================`);

        log.LogPipelineTriggerInput(build);

        // Queue build
        let buildQueueResult = await buildApi.queueBuild(build, build.project.id, true);
        if (buildQueueResult != null) {
            log.LogPipelineTriggerOutput(buildQueueResult);
            // If build result contains validation errors set result to FAILED
            if (buildQueueResult.validationResults != null && buildQueueResult.validationResults.length > 0) {
                let errorAndWarningMessage = p.getErrorAndWarningMessageFromBuildResult(buildQueueResult.validationResults);
                core.setFailed("Errors: " + errorAndWarningMessage.errorMessage + " Warnings: " + errorAndWarningMessage.warningMessage);
            }
            else {
                log.LogPipelineTriggered(pipelineName, projectName);
                if (buildQueueResult._links != null) {
                    log.LogOutputUrl(buildQueueResult._links.web.href);
                }
            }
        }

        // Keep querying the pipeline status until it completes or cancels.
        let buildResult: BuildInterfaces.Build;
        do
        {
            await new Promise(resolve => setTimeout(resolve, buildResult ? 60000 : 0));

            buildResult = await buildApi.getBuild(projectName, buildQueueResult.id);
            core.debug(`Build Status = "${BuildInterfaces.BuildStatus[buildResult.status]}"`);
        } while (buildResult.status == BuildInterfaces.BuildStatus.NotStarted
            || buildResult.status == BuildInterfaces.BuildStatus.InProgress);

        log.LogInfo(`Build Status = "${BuildInterfaces.BuildStatus[buildResult.status]}"`);
        log.LogInfo(`Build Result = "${BuildInterfaces.BuildResult[buildResult.result]}"`);

        if (buildResult.status != BuildInterfaces.BuildStatus.Completed
            || buildResult.result != BuildInterfaces.BuildResult.Succeeded)
        {
            core.setFailed("Build failed or canceled.");
        }

        log.LogInfo("Build succeed.");
        log.LogOutputUrl(buildResult._links.web.href);
    }

    public async RunDesignerPipeline(webApi: azdev.WebApi): Promise<any> {
        let projectName = UrlParser.GetProjectName(this.taskParameters.azureDevopsProjectUrl);
        let pipelineName = this.taskParameters.azurePipelineName;
        let releaseApi = await webApi.getReleaseApi();
        // Get release definitions for the given project name and pipeline name
        const releaseDefinitions: ReleaseInterfaces.ReleaseDefinition[] = await releaseApi.getReleaseDefinitions(projectName, pipelineName, ReleaseInterfaces.ReleaseDefinitionExpands.Artifacts);

        p.EnsureValidPipeline(projectName, pipelineName, releaseDefinitions);

        let releaseDefinition = releaseDefinitions[0];

        log.LogPipelineObject(releaseDefinition);

        // Create ConfigurationVariableValue objects from the input variables
        let variables = undefined
        if (this.taskParameters.azurePipelineVariables) {
            variables = JSON.parse(this.taskParameters.azurePipelineVariables);
            Object.keys(variables).map(function (key, index) {
                let oldValue = variables[key]
                variables[key] = { value: oldValue }
            });
        }

        // Filter Github artifacts from release definition
        let gitHubArtifacts = releaseDefinition.artifacts.filter(p.isGitHubArtifact);
        let artifacts: ReleaseInterfaces.ArtifactMetadata[] = new Array();

        if (gitHubArtifacts == null || gitHubArtifacts.length == 0) {
            core.debug("Pipeline is not linked to any GitHub artifact");
            // If no GitHub artifacts found it means pipeline is not linked to any GitHub artifact
        } else {
            // If pipeline has any matching Github artifact
            core.debug("Pipeline is linked to GitHub artifact. Looking for now matching repository");
            gitHubArtifacts.forEach(gitHubArtifact => {
                if (gitHubArtifact.definitionReference != null && p.equals(gitHubArtifact.definitionReference.definition.name, this.repository)) {
                    // Use custom branch if provided, otherwise use current GitHub branch
                    let targetBranchName = this.taskParameters.azurePipelineBranch || this.getGithubBranchName();
                    let targetBranch = this.formatBranchForAzureDevOps(targetBranchName);
                    core.info(`Final target branch for Azure DevOps: ${targetBranch}`);
                    core.debug(`Original branch input: ${this.taskParameters.azurePipelineBranch}`);
                    core.debug(`GitHub ref: ${this.branch}`);
                    // Add version information for matching GitHub artifact
                    let artifactMetadata = <ReleaseInterfaces.ArtifactMetadata>{
                        alias: gitHubArtifact.alias,
                        instanceReference: <ReleaseInterfaces.BuildVersion>{
                            id: this.commitId,
                            sourceBranch: targetBranch,
                            sourceRepositoryType: this.githubRepo,
                            sourceRepositoryId: this.repository,
                            sourceVersion: this.commitId
                        }
                    }
                    core.debug("pipeline is linked to same Github repo");
                    artifacts.push(artifactMetadata);
                }
            });
        }

        let releaseStartMetadata: ReleaseInterfaces.ReleaseStartMetadata = <ReleaseInterfaces.ReleaseStartMetadata>{
            definitionId: releaseDefinition.id,
            reason: ReleaseInterfaces.ReleaseReason.ContinuousIntegration,
            artifacts: artifacts,
            variables: variables
        };

        log.LogPipelineTriggerInput(releaseStartMetadata);
        // create release
        let release = await releaseApi.createRelease(releaseStartMetadata, projectName);
        if (release != null) {
            log.LogPipelineTriggered(pipelineName, projectName);
            log.LogPipelineTriggerOutput(release);
            if (release != null && release._links != null) {
                log.LogOutputUrl(release._links.web.href);
            }
        }
    }
}