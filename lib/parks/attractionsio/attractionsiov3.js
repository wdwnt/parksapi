// Support for Attractions.io v3 API
import {Destination} from '../destination.js';
import {attractionType, statusType, queueType, tagType, scheduleType, entityType} from '../parkTypes.js';

import moment from 'moment';

export class AttractionsIOV3 extends Destination {
  constructor(options = {}) {
    options.baseURL = options.baseURL || 'https://api.attractions.io';
    options.realTimeBaseURL = options.realTimeBaseURL || "";
    options.parkId = options.parkId || "";
    // optional extra category types to include
    //  the POI config can miss some categories, so we can add them here
    options.extraAttractionCategoryTypes = options.extraAttractionCategoryTypes || [];
    options.extraShowCategoryTypes = options.extraShowCategoryTypes || [];
    options.extraRestaurantCategoryTypes = options.extraRestaurantCategoryTypes || [];

    // category names for each type of entity
    //  we use these to filter POI data
    options.attractionCategories = options.attractionCategories || ['Rides'];
    options.showCategories = options.showCategories || ['Shows'];
    options.diningCategories = options.diningCategories || ['Dining'];

    options.configPrefixes = ['ATTRACTIONSIOV3'];

    super(options);

    if (!this.config.realTimeBaseURL) {
      throw new Error('realTimeBaseURL is required for Attractions.io v3 parks');
    }

    if (!this.config.parkId) {
      throw new Error('parkId is required for Attractions.io v3 parks');
    }
  }

  async fetchWaitTimes() {
    '@cache|1'; // cache for 1 minute
    const response = await this.http('GET', `${this.config.realTimeBaseURL}/wait-times/park/${this.config.parkId}`);
    return response.body;
  }

  async fetchParkConfig() {
    '@cache|1d'; // cache for 1 day
    const response = await this.http('GET', `${this.config.realTimeBaseURL}/config/park/${this.config.parkId}`);
    return response.body;
  }

  async fetchParkPOI() {
    '@cache|1d'; // cache for 1 day
    const response = await this.http('GET', `${this.config.realTimeBaseURL}/poi/park/${this.config.parkId}`);
    return response.body;
  }

  /**
   * Helper function to build a basic entity document
   * Useful to avoid copy/pasting
   * @param {object} data 
   * @returns {object}
   */
  buildBaseEntityObject(data) {
    const entity = Destination.prototype.buildBaseEntityObject.call(this, data);

    if (data?.name) {
      entity.name = data.name;
    }

    // we are using the fimsId as our unique ID
    //  as this is also used for the live wait times
    if (data?.fimsId) {
      entity._id = `${data.fimsId}`;
    }

    if (data?.location && data.location.latitude && data.location.longitude) {
      entity.location = {
        latitude: data.location.latitude,
        longitude: data.location.longitude,
      };
    }

    return entity;
  }

  /**
   * Build the destination entity representing this destination
   */
  async buildDestinationEntity() {
    const parkConfig = await this.fetchParkConfig();

    const doc = {
      name: parkConfig.parkName,
    };
    return {
      ...this.buildBaseEntityObject(doc),
      _id: this.config.destinationId + "_destination",
      slug: this.config.destinationId + "_destination",
      entityType: entityType.destination,
    };
  }

  /**
   * Build the park entities for this destination
   */
  async buildParkEntities() {
    const parkConfig = await this.fetchParkConfig();

    const doc = {
      name: parkConfig.parkName,
    };

    return [
      {
        ...this.buildBaseEntityObject(doc),
        _id: this.config.destinationId,
        _destinationId: this.config.destinationId + "_destination",
        _parentId: this.config.destinationId + "_destination",
        entityType: entityType.park,
      }
    ];
  }

  async getTypesFromCategories(categories, fieldFilter = "type") {
    '@cache|1d'; // cache for 1 day

    // fetch attraction types from park config
    const parkConfig = await this.fetchParkConfig();

    if (!parkConfig || !parkConfig.poi_config || !parkConfig.poi_config.parkModes) {
      return [];
    }

    const types = [];
    // walk through all the park modes and find the valid categories
    //  then grab all the filter IDs from the "type" field
    parkConfig.poi_config.parkModes.forEach((mode) => {
      if (!mode.category || !mode.category.values) return;
      mode.category.values.forEach((cat) => {
        if (categories.indexOf(cat.label || cat.title) >= 0) {
          cat.filters.forEach((filter) => {
            if (!filter.fieldName || !filter.values) return;
            // check if this is the field we're looking for
            //  rides are "type", shows are "showType" etc.
            if (filter.fieldName == fieldFilter) {
              filter.values.forEach((filterValue) => {
                // don't duplicate types
                if (types.indexOf(filterValue.value) < 0) {
                  types.push(filterValue.value);
                }
              });
            }
          });
        }
      });
    });

    return types;
  }

  async getEntitiesForCategory(categories, fieldName, entityData, extraCategoryTypes = []) {
    const types = [].concat(await this.getTypesFromCategories(categories, fieldName)).concat(extraCategoryTypes);
    const poiData = await this.fetchParkPOI();

    // filter out any POI that doesn't have a valid type
    const entities = poiData.filter((poi) => {
      if (!poi[fieldName] || poi[fieldName]?.id === undefined) return false;
      return types.indexOf(poi[fieldName].id) >= 0;
    });

    return entities.map((ride) => {
      return {
        ...this.buildBaseEntityObject(ride),
        ...entityData,
      };
    });
  }

  /**
   * Build the attraction entities for this destination
   */
  async buildAttractionEntities() {
    return this.getEntitiesForCategory(this.config.attractionCategories, "type", {
      _destinationId: this.config.destinationId + "_destination",
      _parentId: this.config.destinationId,
      entityType: entityType.attraction,
      attractionType: attractionType.ride,
    }, this.config.extraAttractionCategoryTypes);
  }

  /**
   * Build the show entities for this destination
   */
  async buildShowEntities() {
    return this.getEntitiesForCategory(this.config.showCategories, "showType", {
      _destinationId: this.config.destinationId + "_destination",
      _parentId: this.config.destinationId,
      entityType: entityType.show,
    }, this.config.extraShowCategoryTypes);
  }

  /**
   * Build the restaurant entities for this destination
   */
  async buildRestaurantEntities() {
    return await this.getEntitiesForCategory(this.config.diningCategories, "foodTypes", {
      _destinationId: this.config.destinationId + "_destination",
      _parentId: this.config.destinationId,
      entityType: entityType.restaurant,
    }, this.config.extraRestaurantCategoryTypes);
  }

  /**
   * @inheritdoc
   */
  async buildEntityLiveData() {
    const liveData = await this.fetchWaitTimes();

    const entries = liveData.venues.reduce((x, venue) => {
      x.push(...venue.details);
      return x;
    }, []);

    return entries.map((x) => {
      const entry = {
        _id: `${x.fimsId}`,
        status: statusType.closed,
      };

      // add standby time (if present)
      if (x.regularWaittime && x.regularWaittime.createdDateTime) {
        if (!entry.queue) {
          entry.queue = {};
        }
        entry.status = statusType.operating;
        entry.queue[queueType.standBy] = {
          waitTime: x.regularWaittime.waitTime || 0,
        };
      }

      // add fastpass time (if present)
      if (x.fastlaneWaittime && x.fastlaneWaittime.createdDateTime) {
        if (!entry.queue) {
          entry.queue = {};
        }
        entry.status = statusType.operating;
        // paid standby type, basically normal queueing, but you get your own line
        entry.queue[queueType.paidStandBy] = {
          waitTime: x.fastlaneWaittime.waitTime || 0,
        };
      }

      return entry;
    });
  }

  async fetchScheduleDataForDate(momentDate) {
    // cache this data for 1 day, unless it's in the next 3 days, then cache for 4 hours
    const cacheTime = momentDate.isBefore(moment().add(3, 'days')) ? 1000 * 60 * 60 * 4 : 1000 * 60 * 60 * 24;
    return this.cache.wrap(`schedule_${momentDate.format('YYYY-MM-DD')}`, async () => {
      // https://2qi9ynkg9d.execute-api.us-east-2.amazonaws.com/operating-hours/park/4?date=20240306
      const date = momentDate.format('YYYYMMDD');
      const response = await this.http('GET', `${this.config.realTimeBaseURL}/operating-hours/park/${this.config.parkId}?date=${date}`);

      if (!response.body || !response.body.operatings || !response.body.operatings.length) {
        return null;
      }

      if (response.body.isParkClosed) {
        return [];
      }

      return response.body.operatings.reduce((arr, operating) => {
        if (!operating.items) return arr;

        if (operating.operatingTypeName != 'Park Hours') return;

        operating.items.forEach((item) => {
          if (!item.timeFrom || !item.timeTo) return;

          const openTime = moment(`${date}T${item.timeFrom}`, "YYYYMMDDTHH:mm").tz(this.config.timezone, true);
          const closeTime = moment(`${date}T${item.timeTo}`, "YYYYMMDDTHH:mm").tz(this.config.timezone, true);

          arr.push({
            date: moment(date).format('YYYY-MM-DD'),
            type: statusType.operating,
            // opening time comes in format "HH:mm" in timeFrom field
            openingTime: openTime.format(),
            closingTime: closeTime.format(),
          });
        });
        return arr;
      }, []);
    }, cacheTime);
  }

  /**
   * Return schedule data for all scheduled entities in this destination
   * Eg. parks
   * @returns {array<object>}
   */
  async buildEntityScheduleData() {
    // fetch next 90 days of schedule data
    const now = moment();
    const nextMonth = moment().add(3, 'month');
    const datesToFetch = [];
    for (const date = now.clone(); date.isBefore(nextMonth); date.add(1, 'day')) {
      datesToFetch.push(date.clone());
    }

    const scheduleData = [];
    for (const date of datesToFetch) {
      const data = await this.fetchScheduleDataForDate(date);
      if (data) {
        scheduleData.push(...data);
      }
    }

    return [
      {
        _id: this.config.destinationId,
        schedule: scheduleData,
      }
    ];
  }
}

export class KnottsBerryFarm extends AttractionsIOV3 {
  constructor(options = {}) {
    options.timezone = 'America/Los_Angeles';
    options.parkId = options.parkId || "4";
    options.destinationId = 'knottsberryfarm';
    options.extraAttractionCategoryTypes = [19]; // 19 is missing from POI config data (water rides)

    super(options);
  }
}

// test run if called directly
(async () => {
  const park = new KnottsBerryFarm();
  //const waitTimes = await park._fetchWaitTimes();
  //console.log(waitTimes);

  //iterateParks();
})();

async function iterateParks() {
  // fetch https://2qi9ynkg9d.execute-api.us-east-2.amazonaws.com/config/park/{PARKID}
  // for all parks from 1 to 20
  const park = new KnottsBerryFarm({
    parkId: 4
  });
  // 1: Cedar Point
  // 4: Knott's Berry Farm
  // 20: King's Island
  // 25: King's Dominion
  // 30: Carowinds
  // 40: Canada's Wonderland
  // 100: Carowinds... again?
  for (let i = 130; i <= 160; i++) {
    // make basic HTTP request
    try {
      const conf = await park.http('GET', `https://2qi9ynkg9d.execute-api.us-east-2.amazonaws.com/config/park/${i}`, null, {
        retries: 0,
      });
      if (conf && conf.body.parkName) {
        console.log(`new ${conf.body.parkName}({parkId: ${i}}),`);
      }
    } catch (err) {
      //console.error(err);
    }
  }
}