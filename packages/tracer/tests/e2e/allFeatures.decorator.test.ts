/**
 * Test tracer in decorator setup
 *
 * @group e2e/tracer/decorator
 */

import path from 'path';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import { App, Stack, RemovalPolicy } from 'aws-cdk-lib';
import * as AWS from 'aws-sdk';
import { v4 } from 'uuid';
import { deployStack, destroyStack } from '../../../commons/tests/utils/cdk-cli';
import {
  getTraces,
  getInvocationSubsegment,
  splitSegmentsByName,
  invokeAllTestCases,
  createTracerTestFunction,
  getFunctionArn,
  getFirstSubsegment,
} from '../helpers/tracesUtils';
import {
  generateUniqueName,
  isValidRuntimeKey,
} from '../../../commons/tests/utils/e2eUtils';
import { 
  RESOURCE_NAME_PREFIX,
  SETUP_TIMEOUT, 
  TEARDOWN_TIMEOUT, 
  TEST_CASE_TIMEOUT,
  expectedCustomAnnotationKey, 
  expectedCustomAnnotationValue, 
  expectedCustomMetadataKey, 
  expectedCustomMetadataValue, 
  expectedCustomResponseValue, 
  expectedCustomErrorMessage,
} from './constants';
import { 
  assertAnnotation,
  assertErrorAndFault,
} from '../helpers/traceAssertions';

const runtime: string = process.env.RUNTIME || 'nodejs18x';

if (!isValidRuntimeKey(runtime)) {
  throw new Error(`Invalid runtime key value: ${runtime}`);
}

/**
 * We will create a stack with 3 Lambda functions:
 * 1. With all flags enabled (capture both response and error)
 * 2. Do not capture error or response
 * 3. Do not enable tracer
 * Each stack must use a unique `serviceName` as it's used to for retrieving the trace.
 * Using the same one will result in traces from different test cases mixing up.
 */
const stackName = generateUniqueName(RESOURCE_NAME_PREFIX, v4(), runtime, 'AllFeatures-Decorator');
const lambdaFunctionCodeFile = 'allFeatures.decorator.test.functionCode.ts';
let startTime: Date;

/**
 * Function #1 is with all flags enabled.
 */
const uuidFunction1 = v4();
const functionNameWithAllFlagsEnabled = generateUniqueName(RESOURCE_NAME_PREFIX, uuidFunction1, runtime, 'AllFeatures-Decorator-AllFlagsEnabled');
const serviceNameWithAllFlagsEnabled = functionNameWithAllFlagsEnabled; 

/**
 * Function #2 doesn't capture error or response
 */
const uuidFunction2 = v4();
const functionNameWithNoCaptureErrorOrResponse = generateUniqueName(RESOURCE_NAME_PREFIX, uuidFunction2, runtime, 'AllFeatures-Decorator-NoCaptureErrorOrResponse');
const serviceNameWithNoCaptureErrorOrResponse = functionNameWithNoCaptureErrorOrResponse; 
/**
 * Function #3 disables tracer
 */
const uuidFunction3 = v4();
const functionNameWithTracerDisabled = generateUniqueName(RESOURCE_NAME_PREFIX, uuidFunction3, runtime, 'AllFeatures-Decorator-TracerDisabled');
const serviceNameWithTracerDisabled = functionNameWithNoCaptureErrorOrResponse; 

/**
 * Function #4 disables capture response via decorator options
 */
const uuidFunction4 = v4();
const functionNameWithCaptureResponseFalse = generateUniqueName(RESOURCE_NAME_PREFIX, uuidFunction4, runtime, 'AllFeatures-Decorator-CaptureResponseFalse');
const serviceNameWithCaptureResponseFalse = functionNameWithCaptureResponseFalse;

const xray = new AWS.XRay();
const invocations = 3;

const integTestApp = new App();
let stack: Stack;

describe(`Tracer E2E tests, all features with decorator instantiation for runtime: ${runtime}`, () => {

  beforeAll(async () => {
    
    // Prepare
    startTime = new Date();
    const ddbTableName = stackName + '-table';
    stack = new Stack(integTestApp, stackName);

    const ddbTable = new Table(stack, 'Table', {
      tableName: ddbTableName,
      partitionKey: {
        name: 'id',
        type: AttributeType.STRING
      },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const entry = path.join(__dirname, lambdaFunctionCodeFile);
    const functionWithAllFlagsEnabled = createTracerTestFunction({
      stack,
      functionName: functionNameWithAllFlagsEnabled,
      entry,
      expectedServiceName: serviceNameWithAllFlagsEnabled,
      environmentParams: {
        TEST_TABLE_NAME: ddbTableName,
        POWERTOOLS_TRACER_CAPTURE_RESPONSE: 'true',
        POWERTOOLS_TRACER_CAPTURE_ERROR: 'true',
        POWERTOOLS_TRACE_ENABLED: 'true',
      },
      runtime
    });
    ddbTable.grantWriteData(functionWithAllFlagsEnabled);

    const functionThatDoesNotCapturesErrorAndResponse = createTracerTestFunction({
      stack,
      functionName: functionNameWithNoCaptureErrorOrResponse,
      entry,
      expectedServiceName: serviceNameWithNoCaptureErrorOrResponse,
      environmentParams: {
        TEST_TABLE_NAME: ddbTableName,
        POWERTOOLS_TRACER_CAPTURE_RESPONSE: 'false',
        POWERTOOLS_TRACER_CAPTURE_ERROR: 'false',
        POWERTOOLS_TRACE_ENABLED: 'true',
      },
      runtime
    });
    ddbTable.grantWriteData(functionThatDoesNotCapturesErrorAndResponse);

    const functionWithTracerDisabled = createTracerTestFunction({
      stack,
      functionName: functionNameWithTracerDisabled,
      entry,
      expectedServiceName: serviceNameWithTracerDisabled,
      environmentParams: {
        TEST_TABLE_NAME: ddbTableName,
        POWERTOOLS_TRACER_CAPTURE_RESPONSE: 'true',
        POWERTOOLS_TRACER_CAPTURE_ERROR: 'true',
        POWERTOOLS_TRACE_ENABLED: 'false',
      },
      runtime
    });
    ddbTable.grantWriteData(functionWithTracerDisabled);

    const functionWithCaptureResponseFalse = createTracerTestFunction({
      stack,
      functionName: functionNameWithCaptureResponseFalse,
      handler: 'handlerWithCaptureResponseFalse',
      entry,
      expectedServiceName: serviceNameWithCaptureResponseFalse,
      environmentParams: {
        TEST_TABLE_NAME: ddbTableName,
        POWERTOOLS_TRACER_CAPTURE_RESPONSE: 'true',
        POWERTOOLS_TRACER_CAPTURE_ERROR: 'true',
        POWERTOOLS_TRACE_ENABLED: 'true',
      },
      runtime
    });
    ddbTable.grantWriteData(functionWithCaptureResponseFalse);

    await deployStack(integTestApp, stack);

    // Act
    await Promise.all([
      invokeAllTestCases(functionNameWithAllFlagsEnabled),
      invokeAllTestCases(functionNameWithNoCaptureErrorOrResponse),
      invokeAllTestCases(functionNameWithTracerDisabled),
      invokeAllTestCases(functionNameWithCaptureResponseFalse),
    ]);
    
  }, SETUP_TIMEOUT);

  afterAll(async () => {
    if (!process.env.DISABLE_TEARDOWN) {
      await destroyStack(integTestApp, stack);
    }
  }, TEARDOWN_TIMEOUT);

  it('should generate all custom traces', async () => {
    
    const tracesWhenAllFlagsEnabled = await getTraces(xray, startTime, await getFunctionArn(functionNameWithAllFlagsEnabled), invocations, 4);
    
    expect(tracesWhenAllFlagsEnabled.length).toBe(invocations);

    // Assess
    for (let i = 0; i < invocations; i++) {
      const trace = tracesWhenAllFlagsEnabled[i];

      /**
       * Expect the trace to have 4 segments:
       * 1. Lambda Context (AWS::Lambda)
       * 2. Lambda Function (AWS::Lambda::Function)
       * 4. DynamoDB (AWS::DynamoDB)
       * 4. Remote call (awslabs.github.io)
       */
      expect(trace.Segments.length).toBe(4);
      const invocationSubsegment = getInvocationSubsegment(trace);
      
      /**
       * Invocation subsegment should have a subsegment '## index.handler' (default behavior for Powertools Tracer)
       * '## index.handler' subsegment should have 3 subsegments
       * 1. DynamoDB (PutItem on the table)
       * 2. awslabs.github.io (Remote call)
       * 3. '### myMethod' (method decorator)
       */
      const handlerSubsegment = getFirstSubsegment(invocationSubsegment);
      expect(handlerSubsegment.name).toBe('## index.handler');
      expect(handlerSubsegment?.subsegments).toHaveLength(3);

      if (!handlerSubsegment.subsegments) {
        fail('"## index.handler" subsegment should have subsegments');
      }
      const subsegments = splitSegmentsByName(handlerSubsegment.subsegments, [ 'DynamoDB', 'awslabs.github.io', '### myMethod' ]);
      expect(subsegments.get('DynamoDB')?.length).toBe(1);
      expect(subsegments.get('awslabs.github.io')?.length).toBe(1);
      expect(subsegments.get('### myMethod')?.length).toBe(1);
      expect(subsegments.get('other')?.length).toBe(0);
      
      const shouldThrowAnError = (i === (invocations - 1));
      if (shouldThrowAnError) {
        assertErrorAndFault(invocationSubsegment, expectedCustomErrorMessage);
      }
    }

  }, TEST_CASE_TIMEOUT);
  
  it('should have correct annotations and metadata', async () => {
    const tracesWhenAllFlagsEnabled = await getTraces(xray, startTime, await getFunctionArn(functionNameWithAllFlagsEnabled), invocations, 4);

    for (let i = 0; i < invocations; i++) {
      const trace = tracesWhenAllFlagsEnabled[i];
      const invocationSubsegment = getInvocationSubsegment(trace);
      const handlerSubsegment = getFirstSubsegment(invocationSubsegment);
      const { annotations, metadata } = handlerSubsegment;

      const isColdStart = (i === 0);
      assertAnnotation({
        annotations,
        isColdStart,
        expectedServiceName: serviceNameWithAllFlagsEnabled,
        expectedCustomAnnotationKey,
        expectedCustomAnnotationValue,
      });
      
      if (!metadata) {
        fail('metadata is missing');
      }
      expect(metadata[serviceNameWithAllFlagsEnabled][expectedCustomMetadataKey])
        .toEqual(expectedCustomMetadataValue);

      const shouldThrowAnError = (i === (invocations - 1));
      if (!shouldThrowAnError) {
        // Assert that the metadata object contains the response
        expect(metadata[serviceNameWithAllFlagsEnabled]['index.handler response'])
          .toEqual(expectedCustomResponseValue);
      }
    }
  }, TEST_CASE_TIMEOUT);

  it('should not capture error nor response when the flags are false', async () => {
    
    const tracesWithNoCaptureErrorOrResponse = await getTraces(xray, startTime, await getFunctionArn(functionNameWithNoCaptureErrorOrResponse), invocations, 4);
    
    expect(tracesWithNoCaptureErrorOrResponse.length).toBe(invocations);

    // Assess
    for (let i = 0; i < invocations; i++) {
      const trace = tracesWithNoCaptureErrorOrResponse[i];

      /**
       * Expect the trace to have 4 segments:
       * 1. Lambda Context (AWS::Lambda)
       * 2. Lambda Function (AWS::Lambda::Function)
       * 3. DynamoDB (AWS::DynamoDB)
       * 4. Remote call (awslabs.github.io)
       */
      expect(trace.Segments.length).toBe(4);
      const invocationSubsegment = getInvocationSubsegment(trace);
      
      /**
       * Invocation subsegment should have a subsegment '## index.handler' (default behavior for Powertools Tracer)
       * '## index.handler' subsegment should have 3 subsegments
       * 1. DynamoDB (PutItem on the table)
       * 2. awslabs.github.io (Remote call)
       * 3. '### myMethod' (method decorator)
       */
      const handlerSubsegment = getFirstSubsegment(invocationSubsegment);
      expect(handlerSubsegment.name).toBe('## index.handler');
      expect(handlerSubsegment?.subsegments).toHaveLength(3);

      if (!handlerSubsegment.subsegments) {
        fail('"## index.handler" subsegment should have subsegments');
      }
      const subsegments = splitSegmentsByName(handlerSubsegment.subsegments, [ 'DynamoDB', 'awslabs.github.io', '### myMethod' ]);
      expect(subsegments.get('DynamoDB')?.length).toBe(1);
      expect(subsegments.get('awslabs.github.io')?.length).toBe(1);
      expect(subsegments.get('### myMethod')?.length).toBe(1);
      expect(subsegments.get('other')?.length).toBe(0);
      
      const shouldThrowAnError = (i === (invocations - 1));
      if (shouldThrowAnError) {
        // Assert that the subsegment has the expected fault
        expect(invocationSubsegment.error).toBe(true);
        expect(handlerSubsegment.error).toBe(true);
        // Assert that no error was captured on the subsegment
        expect(handlerSubsegment.hasOwnProperty('cause')).toBe(false);
      }
    }

  }, TEST_CASE_TIMEOUT);

  it('should not capture response when the decorator\'s captureResponse is set to false', async () => {

    const tracesWithCaptureResponseFalse = await getTraces(xray, startTime, await getFunctionArn(functionNameWithCaptureResponseFalse), invocations, 4);

    expect(tracesWithCaptureResponseFalse.length).toBe(invocations);

    // Assess
    for (let i = 0; i < invocations; i++) {
      const trace = tracesWithCaptureResponseFalse[i];

      /**
       * Expect the trace to have 4 segments:
       * 1. Lambda Context (AWS::Lambda)
       * 2. Lambda Function (AWS::Lambda::Function)
       * 3. DynamoDB (AWS::DynamoDB)
       * 4. Remote call (awslabs.github.io)
       */
      expect(trace.Segments.length).toBe(4);
      const invocationSubsegment = getInvocationSubsegment(trace);

      /**
       * Invocation subsegment should have a subsegment '## index.handler' (default behavior for Powertools Tracer)
       * '## index.handler' subsegment should have 3 subsegments
       * 1. DynamoDB (PutItem on the table)
       * 2. awslabs.github.io (Remote call)
       * 3. '### myMethod' (method decorator)
       */
      const handlerSubsegment = getFirstSubsegment(invocationSubsegment);
      expect(handlerSubsegment.name).toBe('## index.handlerWithCaptureResponseFalse');
      expect(handlerSubsegment?.subsegments).toHaveLength(3);

      if (!handlerSubsegment.subsegments) {
        fail('"## index.handlerWithCaptureResponseFalse" subsegment should have subsegments');
      }
      const subsegments = splitSegmentsByName(handlerSubsegment.subsegments, [ 'DynamoDB', 'awslabs.github.io', '### myMethod' ]);
      expect(subsegments.get('DynamoDB')?.length).toBe(1);
      expect(subsegments.get('awslabs.github.io')?.length).toBe(1);
      expect(subsegments.get('### myMethod')?.length).toBe(1);
      expect(subsegments.get('other')?.length).toBe(0);

      // No metadata because capturing the response was disabled and that's
      // the only metadata that could be in the subsegment for the test.
      const myMethodSegment = subsegments.get('### myMethod')?.[0];
      expect(myMethodSegment).toBeDefined();
      expect(myMethodSegment).not.toHaveProperty('metadata');

      const shouldThrowAnError = (i === (invocations - 1));
      if (shouldThrowAnError) {
        assertErrorAndFault(invocationSubsegment, expectedCustomErrorMessage);
      }
    }

  }, TEST_CASE_TIMEOUT);

  it('should not capture any custom traces when disabled', async () => {
    const expectedNoOfTraces = 2;
    const tracesWithTracerDisabled = await getTraces(xray, startTime, await getFunctionArn(functionNameWithTracerDisabled), invocations, expectedNoOfTraces);
    
    expect(tracesWithTracerDisabled.length).toBe(invocations);

    // Assess
    for (let i = 0; i < invocations; i++) {
      const trace = tracesWithTracerDisabled[i];
      expect(trace.Segments.length).toBe(2);
      
      /**
       * Expect no subsegment in the invocation
       */
      const invocationSubsegment = getInvocationSubsegment(trace);
      expect(invocationSubsegment?.subsegments).toBeUndefined();
      
      const shouldThrowAnError = (i === (invocations - 1));
      if (shouldThrowAnError) {
        expect(invocationSubsegment.error).toBe(true);
      }
    }

  }, TEST_CASE_TIMEOUT);
});

