/**
  Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
  
  Licensed under the Apache License, Version 2.0 (the "License").
  You may not use this file except in compliance with the License.
  A copy of the License is located at
  
      http://www.apache.org/licenses/LICENSE-2.0
  
  or in the "license" file accompanying this file. This file is distributed 
  on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either 
  express or implied. See the License for the specific language governing 
  permissions and limitations under the License.
*/

var AWS = require('aws-sdk');
AWS.config.update({region: process.env.DEPLOYMENT_REGION});  
var dynamoDB = new AWS.DynamoDB();
var sns = new AWS.SNS();

var axios = require('axios');

/**
 * Listens on SNS for IP Address range changes and
 * tracks state in DynamoDB optionally sends messages
 * via Slack and SNS
 */
exports.handler = async (event, context, callback) => {

    console.log('[INFO] handling IP address change event: %j', event);

    try
    {
        var alertCount = 0;

        /**
         * Load parameters from the environment
         */
        var params = createParams();

        /**
         * Download the IP address JSON file
         */
        var allIps = await loadIps(params);

        /**
         * Process the IP Addresses, filtering for the
         * regions and services of interest, notifying 
         * of significant changes and updates DynamoDB
         * to prevent alert fatigue
         */
        await processIPAddresses(params, allIps);
        
        /**
         * Success =)
         */
        console.log("[INFO] successfully processed IP address changes");
        callback(null, "Processing complete");
    }
    catch (error)
    {
    /**
     * Failure =(
     */
        console.log("[ERROR] failed to process IP address changes", error);
        callback(error);
    }

};

/**
 * Compute shared parameters from environment
 */
function createParams()
{
    var params = 
    {
        deploymentRegion: process.env.DEPLOYMENT_REGION,

        regions: JSON.parse(process.env.REGIONS),
        services: JSON.parse(process.env.SERVICES),

        ipUrl: "https://ip-ranges.amazonaws.com/ip-ranges.json",

        dynamoTableName: process.env.DYNAMO_IPADDRESS_TABLE,

        publishSNS: process.env.PUBLISH_SNS === 'true',
        publishSNSTopicArn: process.env.PUBLISH_SNS_TOPIC_ARN,

        publishSlack: process.env.PUBLISH_SLACK === 'true',
        publishSlackWebHook: process.env.PUBLISH_SLACK_WEBHOOK,
    };

    console.log("[INFO] parameters: %j", params);

    return params;
}

/**
 * Main processing loop that filters for each region
 * and service pair and checks in DynamoDB to see if
 * anything has changed and sends the requested notifications
 */
async function processIPAddresses(params, allIps)
{
    var alertCount = 0;

    for (var r = 0; r < params.regions.length; r++)
    {
        for (var s = 0; s < params.services.length; s++)
        {
            var region = params.regions[r];
            var service = params.services[s];
            var newRange = filterIps(region, service, allIps).sort();
            var oldRange = await loadExistingIps(params, region, service);

            if (newRange.toString() != oldRange.toString())
            {
                alertCount++;

                console.log("[INFO] sending alerts for IP address range change detected" +
                    " in region: "   + region +
                    " for service: " + service + 
                    "\nOld range: "  + oldRange.toString() +
                    "\nNew range: "  + newRange.toString());

                /**
                 * Send configured alerts
                 */
                await sendAlerts(params, region, service, oldRange, newRange);

                /**
                 * Track the IP adresses for this service and 
                 * region in DynamoDB
                 */
                await updateDynamoDB(params, region, service, newRange, new Date());
            }
        }
    }

    if (alertCount > 0)
    {
        console.log("[INFO] successfully sent: [%d] IP address range change alerts", alertCount);
    }
    else
    {
        console.log("[INFO] no relevant IP address range changes were found");  
    }
}

/**
 * Loads IP address ranges from the configured url
 */
async function loadIps(params)
{
    try
    {
        console.log("[INFO] loading IP addresses: " + params.ipUrl);
        var result = await axios.get(params.ipUrl);
        return result.data;
    }
    catch (error)
    {
        console.log("[ERROR] failed to load IP address data from: " + params.ipUrl, error);
        throw error;
    }
}

/**
 * Filters for IP addresses in a region for a service
 * returning just the IP addresses
 */
function filterIps(region, service, ips)
{
    return ips.prefixes.filter(function (ip) {
        return (ip.region === region) && (ip.service == service);
    }).map(function(ip) {
        return ip.ip_prefix;
    });
}

/**
 * Loads existing IP addresses from DynamoDB 
 * these will be empty the first time this 
 * function is executed, sorts these on return
 */
async function loadExistingIps(params, region, service)
{
    try
    {
        var getParams = {
            TableName: params.dynamoTableName,
            Key: {
                "region": 
                {
                    S: region
                }, 
                "service": 
                {
                    S: service
                }
            }           
        };

        var item = await dynamoDB.getItem(getParams).promise();

        console.log("[INFO] got dynamodb response: %j", item);

        if (item.Item)
        {
            var existingIps = item.Item.ips.SS;
            return existingIps.sort();
        }
        else
        {
            return [];
        }
    }
    catch (error)
    {
        console.log("[ERROR] failed to fetch records from DynamoDB!", error);
        throw error;
    }
}

/**
 * Updates DynamoDB record with new ip addresses and change
 * timestamp for the requested region and service.
 */
async function updateDynamoDB(params, region, service, ips, lastModified)
{
    try
    {
        var params = {
            TableName: params.dynamoTableName,
            Key: 
            {
                'region' : { 'S': region },
                'service' : { 'S': service }
            },
            UpdateExpression: "SET #ips = :ips, #lastModified = :lastModified",
            ExpressionAttributeNames: {
                "#ips": "ips",
                "#lastModified": "lastModified",
            },
            ExpressionAttributeValues: {
                ":ips": {
                    SS: ips.sort()
                },
                ":lastModified": {  
                    S: lastModified.toISOString()
                }
            },
            ReturnValues: "NONE"            
        };

        await dynamoDB.updateItem(params).promise();
    }
    catch (error)
    {
        console.log("[ERROR] failed to update ip addresses in DynamoDB", error);
        throw error;
    }
}

/**
 * Send a message via SNS or slack depending on configuration
 */
async function sendAlerts(params, region, service, oldRange, newRange)
{
    console.log("[INFO] sending alerts");
    await sendSlack(params, region, service, oldRange, newRange);
    await sendSNS(params, region, service, oldRange, newRange);
}

/**
 * Posts a message to Slack if requested
 */
async function sendSlack(params, region, service, oldRange, newRange)
{
    if (!params.publishSlack)
    {
        console.log("[INFO] Slack notifications are disabled");
        return;
    }

    console.log("[INFO] Slack publishing is enabled publishing to webhook: " + 
        params.publishSlackWebHook);

    let axiosConfig = {
        headers: {
            'Content-Type': 'application/json'
        }
    };

    try
    {
        var body =
        {
            "text": "*AWS IP address range change* detected in region: *" 
            + region + "* for service: *" 
            + service + "*",
            "attachments": [
                {
                    "text": "This may require urgent routing changes!\n\n" +
                    "Old range:\n" + JSON.stringify(oldRange) + "\n\n" +
                    "New range:\n" + JSON.stringify(newRange) + "\n\n" +
                    "More info: https://docs.aws.amazon.com/general/latest/gr/aws-ip-ranges.html\n\n"
                }
            ]
        };

        console.log("[INFO] sending web hook:\n%j", body);

        var result = await axios.post(
            params.publishSlackWebHook,
            body, 
            axiosConfig); 

        console.log("[INFO] successfully posted slack message");
    }
    catch (error)
    {
        console.log("[ERROR] failed to send Slack message", error);
        throw error;
    }
}

/**
 * Sends to SNS if requested
 */
async function sendSNS(params, region, service, oldRange, newRange)
{
    if (!params.publishSNS)
    {
        console.log("[INFO] SNS notifications are disabled");
        return;
    }

    console.log("[INFO] SNS publishing is enabled publishing to topic: " + 
        params.publishSNSTopicArn);

    try
    {
        var payload =
        {
            region: region,
            service: service,
            oldRange: oldRange,
            newRange: newRange
        };

        console.log("[INFO] SNS topic payload: %j", payloadJson);

        var payloadJson = JSON.stringify(payload);

        var request =
        {
            MessageStructure: 'json',
            TopicArn: params.publishSNSTopicArn,
            Subject: "AWS IP range change detected in region: " + region 
                    + " service: " + service,
            Message: JSON.stringify(
                {
                    "default": payloadJson, 
                    "email": "AWS IP range change detected in region: " + region 
                        + " service: " + service 
                        + "\n\nOld range:\n" + JSON.stringify(oldRange) 
                        + "\n\nNew range:\n" + JSON.stringify(newRange), 
                    "sqs": payloadJson, 
                    "http": payloadJson, 
                    "https": payloadJson, 
                    "lambda": payloadJson, 
                    "sms": "AWS IP range change detected: " + region 
                        + " service: " + service
                }
            )
        };

        console.log("[INFO] sending SNS message: %j", request);

        await sns.publish(request).promise();

        console.log("[INFO] successfully published message to SNS");
    }
    catch (error)
    {
        console.log("[ERROR] failed to publish message to SNS", error);
        throw error;
    } 
}

