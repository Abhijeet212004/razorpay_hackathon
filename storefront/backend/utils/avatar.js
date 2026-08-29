const cloudinary = require('cloudinary');

// Avatars are optional.
//
// Registration used to fail outright if Cloudinary was not configured, which meant the
// whole application was unusable without a third-party account. A missing profile picture
// is not a reason to refuse someone an account.

const CLOUDINARY_READY = Boolean(
    process.env.CLOUDINARY_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET,
);

/** A deterministic placeholder, so two people do not get the same face. */
function placeholder(seed) {
    const initial = encodeURIComponent(String(seed || '?').trim().charAt(0).toUpperCase() || '?');
    return {
        public_id: `local/${String(seed || 'user').toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        url: `https://placehold.co/150x150/2874f0/ffffff?text=${initial}`,
    };
}

async function uploadAvatar(dataUri, seed) {
    if (!CLOUDINARY_READY || !dataUri) return placeholder(seed);
    try {
        const uploaded = await cloudinary.v2.uploader.upload(dataUri, {
            folder: 'avatars',
            width: 150,
            crop: 'scale',
        });
        return { public_id: uploaded.public_id, url: uploaded.secure_url };
    } catch (error) {
        console.error(`[avatar] upload failed, using a placeholder: ${error.message}`);
        return placeholder(seed);
    }
}

async function destroyAvatar(publicId) {
    if (!CLOUDINARY_READY || !publicId || publicId.startsWith('local/')) return;
    try {
        await cloudinary.v2.uploader.destroy(publicId);
    } catch (error) {
        console.error(`[avatar] could not remove ${publicId}: ${error.message}`);
    }
}

module.exports = { uploadAvatar, destroyAvatar, CLOUDINARY_READY };
