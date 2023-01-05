import { BaseProvider } from '../BaseProvider';
import { DynamoDBClient, GetItemCommand, paginateQuery } from '@aws-sdk/client-dynamodb';
import type {
  DynamoDBProviderOptions,
  DynamoDBGetOptionsInterface,
  DynamoDBGetMultipleOptionsInterface
} from '../types/DynamoDBProvider';
import type { GetItemCommandInput, QueryCommandInput } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { PaginationConfiguration } from '@aws-sdk/types';

class DynamoDBProvider extends BaseProvider {
  public client: DynamoDBClient;
  protected keyAttr: string = 'id';
  protected sortAttr: string = 'sk';
  protected tableName: string;
  protected valueAttr: string = 'value';

  public constructor(config: DynamoDBProviderOptions) {
    super();

    const clientConfig = config.clientConfig || {};
    this.client = new DynamoDBClient(clientConfig);
    this.tableName = config.tableName;
    if (config.keyAttr) this.keyAttr = config.keyAttr;
    if (config.sortAttr) this.sortAttr = config.sortAttr;
    if (config.valueAttr) this.valueAttr = config.valueAttr;
  }

  public async get(
    name: string,
    options?: DynamoDBGetOptionsInterface
  ): Promise<undefined | string | Record<string, unknown>> {
    return super.get(name, options) as Promise<undefined | string | Record<string, unknown>>;
  }

  public async getMultiple(
    path: string,
    options?: DynamoDBGetMultipleOptionsInterface
  ): Promise<undefined | Record<string, unknown>> {
    return super.getMultiple(path, options);
  }

  protected async _get(
    name: string,
    options?: DynamoDBGetOptionsInterface
  ): Promise<string | undefined> {
    const sdkOptions: GetItemCommandInput = {
      ...(options?.sdkOptions || {}),
      TableName: this.tableName,
      Key: marshall({ [this.keyAttr]: name }),
      ProjectionExpression: this.valueAttr,
    };
    const result = await this.client.send(new GetItemCommand(sdkOptions));

    return result.Item ? unmarshall(result.Item)[this.valueAttr] : undefined;
  }

  protected async _getMultiple(
    path: string,
    options?: DynamoDBGetMultipleOptionsInterface
  ): Promise<Record<string, string | undefined>> {
    const sdkOptions: QueryCommandInput = {
      ...(options?.sdkOptions || {}),
      TableName: this.tableName,
      KeyConditionExpression: `${this.keyAttr} = :key`,
      ExpressionAttributeValues: marshall({ ':key': path }),
      ProjectionExpression: `${this.sortAttr}, ${this.valueAttr}`,
    };
    const paginationOptions: PaginationConfiguration = {
      client: this.client,
      pageSize: options?.sdkOptions?.Limit,
    };

    const parameters: Record<string, string | undefined> = {};
    for await (const page of paginateQuery(paginationOptions, sdkOptions)) {
      for (const item of page.Items || []) {
        const unmarshalledItem = unmarshall(item);
        parameters[
          unmarshalledItem[this.sortAttr]
        ] = unmarshalledItem[this.valueAttr];
      }
    }

    return parameters;
  }
}

export {
  DynamoDBProvider,
};