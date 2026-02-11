const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const {
    getPlaceDetails,
    findPlaceByNameAndLocation,
    getPhotoUrl,
    transformOpeningHours,
    isCacheValid,
    extractAddressComponents
} = require('../services/googlePlacesService');

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = (supabaseUrl && supabaseServiceKey)
    ? createClient(supabaseUrl, supabaseServiceKey)
    : null;

/**
 * GET /academias/:id/details
 * Get detailed information about a gym, using cache or fetching from Google Places API
 */
router.get('/:id/details', async (req, res) => {
    try {
        const { id } = req.params;
        const { forceRefresh } = req.query; // Optional: force refresh from API

        if (!supabase) {
            return res.status(500).json({ error: 'Supabase não configurado' });
        }

        // Get gym from database
        const { data: gym, error: gymError } = await supabase
            .from('academias')
            .select('*')
            .eq('id_academia', id)
            .single();

        if (gymError || !gym) {
            console.error('Error fetching gym from DB:', gymError);
            return res.status(404).json({ error: 'Academia não encontrada' });
        }

        // Check if we should use cache
        const useCachedData = !forceRefresh &&
            gym.ultima_atualizacao_google &&
            isCacheValid(gym.ultima_atualizacao_google);

        if (useCachedData && gym.dados_google_cache) {
            const cachedGoogleData = gym.dados_google_cache;
            const googleAddress = cachedGoogleData.formatted_address || gym.endereco_completo;
            const addressComponents = extractAddressComponents(cachedGoogleData.address_components);
            const lat = cachedGoogleData.geometry?.location?.lat || gym.latitude;
            const lng = cachedGoogleData.geometry?.location?.lng || gym.longitude;

            // Return cached data with Google address prioritized
            return res.json({
                ...gym,
                ...addressComponents,
                endereco_completo: googleAddress,
                latitude: lat,
                longitude: lng,
                source: 'cache',
                cached_at: gym.ultima_atualizacao_google,
                open_now: cachedGoogleData.opening_hours?.open_now
            });
        }

        // Need to fetch from Google Places API
        let placeId = gym.google_place_id;

        // If we don't have a place_id, try to find it
        if (!placeId || forceRefresh) {
            const foundPlace = await findPlaceByNameAndLocation(
                gym.nome,
                gym.latitude,
                gym.longitude,
                gym.endereco_completo
            );

            if (foundPlace) {
                placeId = foundPlace.place_id;
            } else if (!placeId) {
                // Couldn't find on Google Places, return database data only
                return res.json({
                    ...gym,
                    source: 'database',
                    note: 'Google Places data not available'
                });
            }
        }

        // Fetch details from Google Places API
        const placeDetails = await getPlaceDetails(placeId);

        // Transform and prepare data for storage
        const horariosFuncionamento = transformOpeningHours(placeDetails.opening_hours);
        const addressComponents = extractAddressComponents(placeDetails.address_components);
        const googleAddress = placeDetails.formatted_address || gym.endereco_completo;

        const fotos = placeDetails.photos
            ? placeDetails.photos.slice(0, 5).map(photo => ({
                reference: photo.photo_reference,
                url: getPhotoUrl(photo.photo_reference, 800),
                width: photo.width,
                height: photo.height
            }))
            : [];

        // Prepare coordinates and phone from Google
        const lat = placeDetails.geometry?.location?.lat || gym.latitude;
        const lng = placeDetails.geometry?.location?.lng || gym.longitude;
        const googlePhone = placeDetails.formatted_phone_number || placeDetails.international_phone_number;
        const cleanPhoneForWhatsApp = (p) => {
            if (!p) return null;
            const clean = p.replace(/\D/g, '');
            return (clean.length === 11 && clean[2] === '9') ? clean : null;
        };
        const whatsapp = cleanPhoneForWhatsApp(googlePhone) || gym.whatsapp;

        // Update database with fresh data
        const { error: updateError } = await supabase
            .from('academias')
            .update({
                nome: placeDetails.name || gym.nome,
                google_place_id: placeId,
                ...addressComponents,
                endereco_completo: googleAddress,
                latitude: lat,
                longitude: lng,
                website: placeDetails.website || gym.website,
                telefone: googlePhone || gym.telefone,
                whatsapp: whatsapp,
                rating: placeDetails.rating || gym.rating,
                total_avaliacoes: placeDetails.user_ratings_total || gym.total_avaliacoes,
                horarios_funcionamento: horariosFuncionamento,
                fotos: fotos,
                ultima_atualizacao_google: new Date().toISOString(),
                dados_google_cache: placeDetails,
                ativo: placeDetails.business_status === 'OPERATIONAL'
            })
            .eq('id_academia', id);

        if (updateError) {
            console.error('Error updating gym with Google data:', updateError);
        }

        // Return enriched data
        return res.json({
            ...gym,
            nome: placeDetails.name || gym.nome,
            ...addressComponents,
            endereco_completo: googleAddress,
            latitude: lat,
            longitude: lng,
            google_place_id: placeId,
            website: placeDetails.website || gym.website,
            telefone: googlePhone || gym.telefone,
            whatsapp: whatsapp,
            rating: placeDetails.rating || gym.rating,
            total_avaliacoes: placeDetails.user_ratings_total || gym.total_avaliacoes,
            horarios_funcionamento: horariosFuncionamento,
            fotos: fotos,
            google_maps_url: placeDetails.url,
            ativo: placeDetails.business_status === 'OPERATIONAL',
            open_now: placeDetails.opening_hours?.open_now,
            source: 'google_places_api',
            fetched_at: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error getting gym details:', error);
        res.status(500).json({
            error: 'Erro ao buscar detalhes da academia',
            message: error.message
        });
    }
});

module.exports = router;
