import { Middleware, PluginCommonModule, VendurePlugin } from '@vendure/core';
import { gql } from 'apollo-server-core';
import path from 'path';
import { AdminUiExtension } from '@vendure/ui-devkit/compiler';
import bodyParser from 'body-parser';
import {
  AdditionalParcelInputFn,
  CustomFieldFn,
  SendcloudPluginOptions,
} from './api/types/sendcloud.types';
import { SendcloudResolver } from './api/sendcloud.resolver';
import { SendcloudService } from './api/sendcloud.service';
import { PLUGIN_OPTIONS } from './api/constants';
import { SendcloudController } from './api/sendcloud.controller';
import { SendcloudConfigEntity } from './api/sendcloud-config.entity';
import { sendcloudHandler } from './api/sendcloud.handler';
import { sendcloudPermission } from './index';
import { createRawBodyMiddleWare } from '../../util/src/raw-body';

@VendurePlugin({
  adminApiExtensions: {
    schema: gql`
      type SendCloudConfig {
        id: ID!
        secret: String
        publicKey: String
      }
      input SendCloudConfigInput {
        secret: String
        publicKey: String
      }
      extend type Mutation {
        sendToSendCloud(orderId: ID!): Boolean!
        updateSendCloudConfig(input: SendCloudConfigInput): SendCloudConfig!
      }
      extend type Query {
        sendCloudConfig: SendCloudConfig
      }
    `,
    resolvers: [SendcloudResolver],
  },
  providers: [
    SendcloudService,
    {
      provide: PLUGIN_OPTIONS,
      useFactory: () => SendcloudPlugin.options,
    },
  ],
  imports: [PluginCommonModule],
  controllers: [SendcloudController],
  entities: [SendcloudConfigEntity],
  configuration: (config) => {
    config.shippingOptions.fulfillmentHandlers.push(sendcloudHandler);
    config.authOptions.customPermissions.push(sendcloudPermission);
    // save rawBody for signature verification
    config.apiOptions.middleware.push(
      createRawBodyMiddleWare('/sendcloud/webhook*')
    );
    return config;
  },
})
export class SendcloudPlugin {
  private static options: SendcloudPluginOptions;

  static init(options: SendcloudPluginOptions): typeof SendcloudPlugin {
    this.options = options;
    return SendcloudPlugin;
  }

  static ui: AdminUiExtension = {
    extensionPath: path.join(__dirname, 'ui'),
    ngModules: [
      {
        type: 'lazy',
        route: 'sendcloud',
        ngModuleFileName: 'sendcloud.module.ts',
        ngModuleName: 'SendcloudModule',
      },
      {
        type: 'shared',
        ngModuleFileName: 'sendcloud-nav.module.ts',
        ngModuleName: 'SendcloudNavModule',
      },
    ],
  };
}
