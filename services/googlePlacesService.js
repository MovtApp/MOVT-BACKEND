const axios = require('axios');

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const GOOGLE_PLACES_BASE_URL = 'https://maps.googleapis.com/maps/api/place';

/**
 * Fetch detailed information about a place from Google Places API
 */
async function getPlaceDetails(placeId) {
    try {
        const fields = [
            'name',
            'formatted_address',
            'address_components',
            'formatted_phone_number',
            'international_phone_number',
            'website',
            'opening_hours',
            'rating',
            'user_ratings_total',
            'photos',
            'geometry',
            'business_status',
            'url'
        ].join(',');

        const response = await axios.get(`${GOOGLE_PLACES_BASE_URL}/details/json`, {
            params: {
                place_id: placeId,
                fields,
                key: GOOGLE_PLACES_API_KEY,
                language: 'pt-BR'
            }
        });

        if (response.data.status !== 'OK') {
            throw new Error(`Google Places API error: ${response.data.status}`);
        }

        return response.data.result;
    } catch (error) {
        console.error('Error fetching place details:', error);
        throw error;
    }
}

/**
 * Extract address components from Google Places result
 */
function extractAddressComponents(components) {
    if (!components) return {};

    const mapping = {
        route: 'rua',
        street_number: 'numero',
        sublocality_level_1: 'bairro',
        administrative_area_level_2: 'cidade',
        administrative_area_level_1: 'estado',
        postal_code: 'cep'
    };

    const result = {};
    components.forEach(component => {
        const type = component.types.find(t => mapping[t]);
        if (type) {
            result[mapping[type]] = type === 'administrative_area_level_1' ? component.short_name : component.long_name;
        }
    });

    return result;
}

/**
 * Calculate distance between two points in meters
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // metres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) *
        Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Search for a place by name and location
 */
async function findPlaceByNameAndLocation(name, latitude, longitude, address = '') {
    try {
        // Try Nearby Search first (150m radius)
        const nearbyResponse = await axios.get(`${GOOGLE_PLACES_BASE_URL}/nearbysearch/json`, {
            params: {
                location: `${latitude},${longitude}`,
                radius: 150,
                keyword: name,
                key: GOOGLE_PLACES_API_KEY,
            }
        });

        if (nearbyResponse.data.status === 'OK' && nearbyResponse.data.results.length > 0) {
            return nearbyResponse.data.results[0];
        }

        // If Nearby Search fails, try Text Search but validate distance
        const fullQuery = address ? `${name} ${address}` : `${name} academia`;
        const searchResponse = await axios.get(`${GOOGLE_PLACES_BASE_URL}/textsearch/json`, {
            params: {
                query: fullQuery,
                location: `${latitude},${longitude}`,
                radius: 500,
                key: GOOGLE_PLACES_API_KEY,
                language: 'pt-BR'
            }
        });

        if (searchResponse.data.status === 'OK' && searchResponse.data.results.length > 0) {
            const place = searchResponse.data.results[0];
            const distance = getDistance(latitude, longitude, place.geometry.location.lat, place.geometry.location.lng);

            if (distance < 500) {
                return place;
            }
        }

        return null;
    } catch (error) {
        console.error('Error finding place:', error);
        return null;
    }
}

/**
 * Get photo URL from photo reference
 */
function getPhotoUrl(photoReference, maxWidth = 400) {
    return `${GOOGLE_PLACES_BASE_URL}/photo?maxwidth=${maxWidth}&photo_reference=${photoReference}&key=${GOOGLE_PLACES_API_KEY}`;
}

/**
 * Transform Google Places opening hours to our format
 */
function transformOpeningHours(openingHours) {
    if (!openingHours) return null;

    const daysOfWeek = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    const formatted = {};

    // Handle 24/7 case
    if (openingHours.periods &&
        openingHours.periods.length === 1 &&
        openingHours.periods[0].open.day === 0 &&
        openingHours.periods[0].open.time === '0000' &&
        !openingHours.periods[0].close) {

        daysOfWeek.forEach(day => {
            formatted[day] = [{ abre: '0000', fecha: '2359' }];
        });
        return formatted;
    }

    if (!openingHours.periods) return null;

    openingHours.periods.forEach(period => {
        const day = daysOfWeek[period.open.day];
        if (!formatted[day]) {
            formatted[day] = [];
        }

        const opening = {
            abre: period.open.time,
            fecha: period.close ? period.close.time : '2359'
        };

        formatted[day].push(opening);
    });

    return formatted;
}

/**
 * Check if cached data is still valid
 */
function isCacheValid(lastUpdate) {
    if (!lastUpdate) return false;
    const cacheAge = new Date() - new Date(lastUpdate);
    const thirtyDaysInMs = 30 * 24 * 60 * 60 * 1000;
    return cacheAge < thirtyDaysInMs;
}

module.exports = {
    getPlaceDetails,
    findPlaceByNameAndLocation,
    getPhotoUrl,
    transformOpeningHours,
    isCacheValid,
    extractAddressComponents
};
