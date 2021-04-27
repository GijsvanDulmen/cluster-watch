module.exports = class EventManager {
    constructor(waitFor, specs) {
        this.eventBuffer = [];
        this.nextSendEventTimer = undefined;
        this.specs = specs;
        this.waitFor = waitFor;
    }

    add(event) {
        this.eventBuffer.push(event);
        this.nextSendEventTimer = setTimeout(() => {
            let groups = {};
            this.eventBuffer.forEach(event => {
                if ( groups[event.getGroupingKey()] == undefined ) {
                    groups[event.getGroupingKey()] = [];
                }

                groups[event.getGroupingKey()].push(event);
            });

            Object.keys(groups).forEach(group => {
                this.specs.forEach(spec => {
                    if ( spec.filter == true ) {
                        const filtered = groups[group].filter(event => {
                            let matches = false;
                            event.getFilterKeys().forEach(filterKey => {
                                if ( spec.keys.indexOf(filterKey) != -1 ) {
                                    matches = true;
                                }
                            });
                            return matches;
                        });

                        if ( filtered.length > 0 ) {
                            spec.bot.sendMultiple(filtered);
                        }
                    } else {
                        spec.bot.sendMultiple(groups[group]);    
                    }
                });
            });

            this.eventBuffer = [];
        }, this.waitFor);
    }
}