module.exports = class Event {
    constructor(groupHeader, detailMessage, color, icon, groupingKey, filterKeys) {
        this.groupHeader = groupHeader;
        this.detailMessage = detailMessage;
        this.color = color;
        this.icon = icon;
        this.groupingKey = groupingKey == undefined ? false : groupingKey;

        if ( filterKeys == undefined ) {
            this.filterKeys = [];
        } else if ( typeof filterKeys == 'string' ) {
            this.filterKeys = [filterKeys];
        } else {
            this.filterKeys = filterKeys;
        }
    }

    getColor() {
        return this.color;
    }

    getIcon() {
        return this.icon;
    }

    getGroupingKey() {
        return this.groupingKey;
    }

    getFilterKeys() {
        return this.filterKeys;
    }

    getGroupHeader() {
        return this.groupHeader;
    }

    getDetailMessage() {
        return this.detailMessage;
    }
}