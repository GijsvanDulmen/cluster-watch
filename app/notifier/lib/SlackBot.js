const { WebClient } = require('@slack/web-api');

module.exports = class SlackBot {
    constructor(channel, token, logger) {
        this.channel = channel;
        this.logger = logger;
        this.api = new WebClient(token);

        this.logger.info("using slack channel: " + this.channel);
    }

    send(text, color, icon) {
        this.api.chat.postMessage({
            channel: this.channel,
            attachments: [
                {
                    text: icon + ' ' + text,
                    color: color
                }
            ]
        }).then(res => {
            this.logger.info(res);
        }).catch(err => {
            this.logger.error(err);
        });
    };
}