const dotenv = require('dotenv-json')({ path:'../.env.json' });

const { DynamoDBClient, ScanCommand, QueryCommand, paginateScan } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

const config = require('../config');

// Job only has a couple of pieces of work to do
//   1. read out all unfinished work from Dynamo
//   2. push messages (jobs) into SQS
//
async function job_handler()  {
    const dynamoClient = new DynamoDBClient(config.getAWSConfig());
    const docClient = DynamoDBDocumentClient.from(dynamoClient);
    const sqsClient = new SQSClient(config.getAWSConfig(true));
    let lastEvaluatedKey = undefined;
    const groupedItems = {};

    do {
        try {
            // Query DynamoDB for work to be done and paginate through results
            const params = {
                TableName: process.env.DYNAMO_RAW_WEBHOOK_TABLE,
                FilterExpression: '#fetched = :value',
                ExpressionAttributeNames: {
                    '#fetched': 'fetched'
                },
                ExpressionAttributeValues: {
                    ':value': { S: 'false' } 
                },
                ExclusiveStartKey: lastEvaluatedKey  // pagination
            };
                        
            const response = await dynamoClient.send(new ScanCommand(params));

            // Process the items returned by the current page
            response.Items.forEach(item => {
                console.dir(item);
                // the key aggregates all webhook events for a single activity
                // for each user. 
                const key = `${item.object_id.N}-${item.owner_id.N}`;
                groupedItems[key] = groupedItems[key] || [];
                groupedItems[key].push(item);
            });

            // Set the lastEvaluatedKey for the next page
            lastEvaluatedKey = response.LastEvaluatedKey;

        } catch (error) {
            console.error("Error:", error);
            return { statusCode: 500, body: "Internal Server Error" };
        }

    } while( lastEvaluatedKey )
//    console.dir(groupedItems);

    // run through the group and create a single task to be pushed into SQS
    // for each owner / activity pair. 
    // if message was successfully created, flip the fetched flag for all
    // related records.
    //
    try {
        for (const [key, items] of Object.entries(groupedItems)) {
            if (items.length > 0) {
                let messageBody = {};

                // if there is a delete record in the list, that
                // trumps everything else.
                const deleteItems = items.filter(item => item.aspect_type.S === "delete");
                if( deleteItems.length > 0 ) {
                    const item = deleteItems[0];
                    console.log('***** DELETE *****');
                    messageBody = {
                        owner_id: item.owner_id.N,
                        object_id: item.object_id.N,
                        archive_id: item.archive_id.S,
                        aspect_type: 'delete'
                    };
                } else {
                    const item = items[0];
                    messageBody = {
                        owner_id: item.owner_id.N,
                        object_id: item.object_id.N,
                        archive_id: item.archive_id.S,
                        aspect_type: item.aspect_type.S
                    };
                }

                console.dir(messageBody);
                const params = {
                    QueueUrl: config.getSQSConfig(),
                    MessageBody: JSON.stringify(messageBody),
                };

                // Send the message to SQS
                const result = await sqsClient.send(new SendMessageCommand(params));
                console.log(`Message sent for key ${key}:`, result.MessageId);
            }
        }
        return { statusCode: 200, body: "Process completed successfully" };
    } catch (error) {
        console.error("Error:", error);
        return { statusCode: 500, body: "Internal Server Error" };
    }
        
};

exports.handler = job_handler;
