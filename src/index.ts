import type CloudFormation from 'aws-sdk/clients/cloudformation';
import type Serverless from 'serverless';
import type ServerlessPlugin from 'serverless/classes/Plugin';
import type Service from 'serverless/classes/Service';
import type {
    CloudFormationResources,
    Output,
} from 'serverless/plugins/aws/provider/awsProvider';
import {
    DEFAULT_EXPORT_PREFIX,
    DEFAULT_OUT_DIR,
    DEFAULT_OUT_FILENAME,
    collectAccessRolesArnFromStackOutputs,
    collectResourceExportsByPrefix,
    exportToFile,
    generateAccessRoleOutput,
    generateAccessRoleResource,
    generateIamRoleResourceLogicalName,
    generatePolicyStatementsByType,
    splitResourceExportKey,
} from './lib/utils';
import {
    AccessRolesGenerator,
    Export,
    ListExportData,
    ResourceExport,
    ServerlessResources,
} from './type/serverless-access-roles-generator';

class ServerlessExportResources implements ServerlessPlugin {
    serverless: Serverless;
    options: Serverless.Options;
    hooks: ServerlessPlugin.Hooks;
    service: Service;
    log: ServerlessPlugin.Logging['log'];

    accessRolesGenerator: AccessRolesGenerator;

    resourceExports: Record<string, ResourceExport>;

    constructor(
        serverless: Serverless,
        options: Serverless.Options,
        { log }: { log: ServerlessPlugin.Logging['log'] },
    ) {
        this.serverless = serverless;
        this.options = options;
        this.service = serverless.service;
        this.log = log;

        this.serverless.configSchemaHandler.defineCustomProperties({
            type: 'object',
            properties: {
                accessRolesGenerator: {
                    type: 'object',
                    properties: {
                        principalAccountId: { type: 'string' },
                        principalRoleName: { type: 'string' },
                        externalId: { type: 'string' },
                        exportPrefix: { type: 'string' },
                        outDir: { type: 'string' },
                        outFilename: { type: 'string' },
                    },
                    required: [
                        'principalAccountId',
                        'principalRoleName',
                        'externalId',
                    ],
                },
            },
        });

        this.hooks = {
            initialize: () => this.initialize(),
            'before:package:finalize':
                this.updateServerlessResources.bind(this),
            'after:deploy:deploy': this.export.bind(this),
        };
    }

    private async initialize() {
        const accessRolesGenerator = this.service.custom
            .accessRolesGenerator as AccessRolesGenerator;

        this.accessRolesGenerator = {
            ...accessRolesGenerator,
            exportPrefix:
                accessRolesGenerator.exportPrefix || DEFAULT_EXPORT_PREFIX,
            outDir: DEFAULT_OUT_DIR,
            outFilename: DEFAULT_OUT_FILENAME,
        };

        const exports = await this.listExports();
        this.resourceExports = collectResourceExportsByPrefix(
            this.accessRolesGenerator.exportPrefix,
            exports,
        );

        this.log.success(
            `Found ${
                Object.keys(this.resourceExports).length
            } exports from other stacks!`,
        );
    }

    /**
     * Generate custom access roles to other exported resources
     */
    private updateServerlessResources() {
        const originalResources = this.service.resources.Resources || {};
        const originalOutputs =
            (this.service.resources as ServerlessResources)?.Outputs || {};
        const { resources, outputs } = this.generateAccessRoles();

        this.service.resources = {
            ...this.service.resources,
            Resources: {
                ...originalResources,
                ...resources,
            },
            Outputs: {
                ...originalOutputs,
                ...outputs,
            },
        };

        this.log.success('Successfully generate custom access roles!');
    }

    /**
     * Export resource outputs to file
     */
    private async export() {
        const provider = this.serverless.getProvider('aws');
        const serviceName = this.service.getServiceName();
        const stackName = `${serviceName}-${provider.getStage()}`;

        try {
            const data = await provider.request(
                'CloudFormation',
                'describeStacks',
                { StackName: stackName },
                { region: provider.getRegion(), useCache: true },
            );

            const stackOutputs = data.Stacks[0]
                .Outputs as CloudFormation.Outputs;
            if (!stackOutputs) {
                throw new Error(`Unable to describe stack: ${serviceName}`);
            }

            const resourceOutputs = collectAccessRolesArnFromStackOutputs(
                stackOutputs,
                this.resourceExports,
            );

            const outFile = exportToFile(
                this.serverless.serviceDir,
                this.accessRolesGenerator.outDir,
                this.accessRolesGenerator.outFilename,
                JSON.stringify(resourceOutputs),
            );

            this.log.success(
                `Successfully export services information to: ${outFile}`,
            );
        } catch (error) {
            this.log.error((error as Error).toString());
            throw error;
        }
    }

    private async listExports() {
        const provider = this.serverless.getProvider('aws');

        try {
            let exports: Export[] = [];
            let nextToken: string | null = null;

            do {
                const data = (await provider.request(
                    'CloudFormation',
                    'listExports',
                    nextToken ? { NextToken: nextToken } : {},
                    { region: provider.getRegion(), useCache: true },
                )) as ListExportData;

                if (!data) throw new Error('Unable to list exports');

                exports = exports.concat(data.Exports);

                nextToken = data.NextToken || null;
            } while (nextToken);

            return exports;
        } catch (error) {
            this.log.error((error as Error).toString());
            throw error;
        }
    }

    private generateAccessRoles() {
        const { principalAccountId, principalRoleName, externalId } =
            this.accessRolesGenerator;

        const resources: CloudFormationResources = {};
        const outputs: Record<string, Output> = {};

        for (const key in this.resourceExports) {
            const { stackName, name, type } = splitResourceExportKey(key);
            const resource = this.resourceExports[key] as ResourceExport;

            const logicalName = generateIamRoleResourceLogicalName(
                stackName,
                name,
                type,
            );

            resources[logicalName] = generateAccessRoleResource(
                stackName,
                name,
                { principalAccountId, principalRoleName, externalId },
                generatePolicyStatementsByType(resource.arn, type),
            );

            const outputKey = `${logicalName}Arn`;
            outputs[outputKey] = generateAccessRoleOutput(
                stackName,
                name,
                logicalName,
            );

            // Update resource role with roleName for later processing
            resource.roleOutputKey = outputKey;
        }

        return { resources, outputs };
    }
}

module.exports = ServerlessExportResources;
