const { WebClient } = require('@slack/web-api');

module.exports = class SlackBot {
    constructor(channel, token, logger) {
        this.channel = channel;
        this.logger = logger;
        this.api = new WebClient(token);

        this.logger.info("using slack channel: " + this.channel);
    }

    sendMultiple(events) {
        let blocks = [];
        blocks.push({
            type: "section",
            text: {
                type: "mrkdwn",
                text: events[0].getIcon() + ' ' + events[0].getGroupHeader()
            }
        });
        
        blocks.push(...events.map(event => {
            return {
                type: "context",
                elements: [
                    {
                        type: "mrkdwn",
                        text: event.getDetailMessage()
                    }
                ]
            }
        })); 

        /*
        blocks.push({
            type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: "*" + new Date().toLocaleDateString('nl-NL') + "*"
				}
			]
        });
        

        blocks.push({
			type: "divider"
		});
        */

        this.api.chat.postMessage({
            channel: this.channel,
            attachments: [
                {
                    color: events[0].getColor(),
                    blocks: blocks
                }
            ]
        }).then(res => {
            this.logger.info(res);
        }).catch(err => {
            this.logger.error(err);
        });
    }
}