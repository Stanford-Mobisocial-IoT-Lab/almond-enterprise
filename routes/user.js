// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// This file is part of ThingEngine
//
// Copyright 2015 The Board of Trustees of the Leland Stanford Junior University
//
// Author: Giovanni Campagna <gcampagn@cs.stanford.edu>
//
// See COPYING for details
"use strict";

const Url = require('url');
const express = require('express');
const passport = require('passport');
const jwt = require('jsonwebtoken');
const util = require('util');
const crypto = require('crypto');
const thirtyTwo = require('thirty-two');
const totp = require('notp').totp;

const userUtils = require('../util/user');
const model = require('../model/user');
const oauthModel = require('../model/oauth2');
const roleModel = require('../model/role');
const db = require('../util/db');
const secret = require('../util/secret_key');
const SendMail = require('../util/sendmail');

const Config = require('../config');

const TOTP_PERIOD = 30; // duration in second of TOTP code

var router = express.Router();

router.get('/login', (req, res, next) => {
    if (req.user) {
        if (req.session.completed2fa || req.user.totp_key === null)
            res.redirect('/');
        else
            res.redirect('/user/2fa/login');
        return;
    }

    db.withClient((dbClient) => {
        return roleModel.getAllWithFlag(dbClient, userUtils.RoleFlags.CAN_REGISTER);
    }).then((roles) => {
        res.render('login', {
            csrfToken: req.csrfToken(),
            errors: req.flash('error'),
            page_title: req._("Almond - Login"),
            roles
        });
    });
});


router.post('/login', passport.authenticate('local', { failureRedirect: '/user/login',
                                                       failureFlash: 'Invalid OTP code' }), (req, res, next) => {
    req.session.completed2fa = false;
    if (req.user.totp_key) {
        // if 2fa is enabled, redirect to the 2fa login page
        res.redirect(303, '/user/2fa/login');
    } else {
        // Redirection back to the original page
        var redirect_to = req.session.redirect_to ? req.session.redirect_to : '/';
        delete req.session.redirect_to;
        if (redirect_to.startsWith('/user/login'))
            redirect_to = '/';
        res.redirect(303, redirect_to);
    }
});

router.get('/2fa/login', (req, res, next) => {
    if (!req.user) {
        // redirect to login page if we get here by accident
        res.redirect('/user/login');
        return;
    }
    if (req.session.completed2fa) {
        res.redirect('/');
        return;
    }

    res.render('2fa_login', {
        page_title: req._("Almond - Login"),
        errors: req.flash('error'),
    });
});

router.post('/2fa/login', passport.authenticate('totp', { failureRedirect: '/user/2fa/login',
                                                          failureFlash: true }), (req, res, next) => {
    req.session.completed2fa = true;

    // Redirection back to the original page
    var redirect_to = req.session.redirect_to ? req.session.redirect_to : '/';
    delete req.session.redirect_to;
    if (redirect_to.startsWith('/user/login') || redirect_to.startsWith('/user/2fa/login'))
        redirect_to = '/';
    res.redirect(303, redirect_to);
});

router.get('/2fa/setup', userUtils.requireLogIn, (req, res, next) => {
    if (req.user.totp_key !== null && req.query.force !== '1') {
        res.status(400).render('error', {
            page_title: req._("Almond - Error"),
            message: req._("You already configured two-factor authentication.")
        });
        return;
    }

    // 128 bit key
    const totpKey = crypto.randomBytes(16);

    const encryptedKey = secret.encrypt(totpKey);
    const encodedKey = thirtyTwo.encode(totpKey).toString().replace(/=/g, '');

    // TRANSLATORS: this is the label used to represent Almond in 2-FA/MFA apps
    // such as Google Authenticator or Duo Mobile; %s is the username

    const hostname = Url.parse(Config.SERVER_ORIGIN).hostname;
    const label = encodeURIComponent(req.user.username.replace(' ', '_')) + '@' + hostname;
    const qrUrl = `otpauth://totp/${label}?secret=${encodedKey}`;

    res.render('2fa_setup', {
        page_title: req._("Almond - Two-Factor Authentication"),
        encryptedKey,
        qrUrl
    });
});

router.post('/2fa/setup', userUtils.requireLogIn, (req, res, next) => {
    db.withTransaction(async (dbClient) => {
        // recover the key that was passed to the client
        const encryptedKey = req.body.encrypted_key;
        const totpKey = secret.decrypt(encryptedKey);

        // check that the user provided a valid OTP token
        // this ensures that they set up their Authenticator app correctly
        const rv = totp.verify(req.body.code, totpKey, { window: 6, time: TOTP_PERIOD });
        if (!rv) {
            res.render('error', {
                page_title: req._("Almond - Two-Factor Authentication"),
                message: req._("Invalid OTP Code. Please check that your Authenticator app is properly configured.")
            });
            return;
        }

        // finally update the database, enabling 2fa
        await model.update(dbClient, req.user.id, { totp_key: encryptedKey });

        // mark that 2fa was successful for this session
        req.session.completed2fa = true;

        res.render('message', {
            page_title: req._("Almond - Two-Factor Authentication"),
            message: req._("Two-factor authentication was set up successfully. You will need to use your Authenticator app at the next login.")
        });
    }).catch(next);
});

router.get('/register', (req, res, next) => {
    res.render('register', {
        csrfToken: req.csrfToken(),
        page_title: req._("Almond - Register"),
        role: req.query.role
    });
});


async function sendValidationEmail(cloudId, username, email) {
    const token = await util.promisify(jwt.sign)({
        sub: cloudId,
        aud: 'email-verify',
        email: email
    }, secret.getJWTSigningKey(), { expiresIn: 1200 /* seconds */ });

    const mailOptions = {
        from: Config.EMAIL_FROM_USER,
        to: email,
        subject: 'Welcome To Almond!',
        text:
`Welcome to Almond!

To verify your email address, please click the following link:
<${Config.SERVER_ORIGIN}/user/verify-email/${token}>

----
You are receiving this email because someone used your address to
register an account on the Almond service at <${Config.SERVER_ORIGIN}>.
`
    };

    return SendMail.send(mailOptions);
}

function login(req, user) {
    return new Promise((resolve, reject) => {
        req.login(user, (err) => {
            if (err)
                reject(err);
            else
                resolve();
        });
    });
}

router.post('/register', (req, res, next) => {
    var options = {};
    try {
        if (typeof req.body['username'] !== 'string' ||
            req.body['username'].length === 0 ||
            req.body['username'].length > 255)
            throw new Error(req._("You must specify a valid username"));
        options.username = req.body['username'];
        if (typeof req.body['email'] !== 'string' ||
            req.body['email'].length === 0 ||
            req.body['email'].indexOf('@') < 0 ||
            req.body['email'].length > 255)
            throw new Error(req._("You must specify a valid email"));
        options.email = req.body['email'];

        if (typeof req.body['password'] !== 'string' ||
            req.body['password'].length < 8 ||
            req.body['password'].length > 255)
            throw new Error(req._("You must specifiy a valid password (of at least 8 characters)"));

        if (req.body['confirm-password'] !== req.body['password'])
            throw new Error(req._("The password and the confirmation do not match"));
        options.password = req.body['password'];

    } catch(e) {
        res.render('register', {
            csrfToken: req.csrfToken(),
            page_title: req._("Almond - Register"),
            error: e
        });
        return;
    }

    Promise.resolve().then(async () => {
        const user = await db.withTransaction(async (dbClient) => {
            let role;
            try {
                role = await roleModel.get(dbClient, req.body.role);
                if ((role.flags & userUtils.RoleFlags.CAN_REGISTER) !== userUtils.RoleFlags.CAN_REGISTER)
                    throw new Error(`Cannot register in role ${req.body.role}`);
            } catch(e) {
                res.render('error', {
                    page_title: req._("Almond - Error"),
                    message: e
                });
                return null;
            }
            options.role = role.id;
            options.approved = !(role.flags & userUtils.RoleFlags.REQUIRE_APPROVAL);

            let user;
            try {
                user = await userUtils.register(dbClient, req, options);
            } catch(e) {
                res.render('register', {
                    csrfToken: req.csrfToken(),
                    page_title: req._("Almond - Register"),
                    error: e
                });
                return null;
            }
            await login(req, user);
            return user;
        });
        if (!user)
            return;
        await sendValidationEmail(user.cloud_id, user.username, user.email);

        // skip login & 2fa for newly created users
        req.session.completed2fa = true;
        res.locals.authenticated = true;
        res.locals.user = user;
        res.render('register_success', {
            page_title: req._("Almond - Registration Successful"),
            username: options.username });
    }).catch(next);
});


router.get('/logout', (req, res, next) => {
    req.logout();
    req.session.completed2fa = false;
    res.locals.authenticated = false;
    res.redirect(303, '/');
});

router.get('/verify-email/:token', userUtils.requireLogIn, (req, res, next) => {
    db.withTransaction(async (dbClient) => {
        let decoded;
        try {
            decoded = await util.promisify(jwt.verify)(req.params.token, secret.getJWTSigningKey(), {
                algorithms: ['HS256'],
                audience: 'email-verify',
                subject: req.user.cloud_id
            });
        } catch(e) {
            res.status(400).render('error', {
                page_title: req._("Almond - Error"),
                message: req._("The verification link you have clicked is not valid. You might be logged-in as the wrong user, or the link might have expired.")
            });
            return;
        }

        await model.verifyEmail(dbClient, decoded.sub, decoded.email);
        res.render('email_verified', {
            page_title: req._("Almond - Verification Successful")
        });
    }).catch(next);
});

router.post('/resend-verification', userUtils.requireLogIn, (req, res, next) => {
    if (req.user.email_verified) {
        res.status(400).render('error', {
            page_title: req._("Almond - Error"),
            message: req._("Your email address was already verified.")
        });
        return;
    }

    sendValidationEmail(req.user.cloud_id, req.user.username, req.user.email).then(() => {
        res.render('message', {
            page_title: req._("Almond - Verification Sent"),
            message: req._("A verification email was sent to %s. If you did not receive it, please check your Spam folder.").format(req.user.email)
        });
    }).catch(next);
});

router.get('/recovery/start', (req, res, next) => {
    res.render('password_recovery_start', {
        page_title: req._("Almond - Password Reset")
    });
});

async function sendRecoveryEmail(cloudId, username, email) {
    const token = await util.promisify(jwt.sign)({
        sub: cloudId,
        aud: 'pw-recovery',
    }, secret.getJWTSigningKey(), { expiresIn: 1200 /* seconds */ });

    const mailOptions = {
        from: Config.EMAIL_FROM_USER,
        to: email,
        subject: 'Almond Password Reset',
        text:
`Hi ${username},

We have been asked to reset your Almond password.
To continue, please click the following link:
<${Config.SERVER_ORIGIN}/user/recovery/continue/${token}>

----
You are receiving this email because someone tried to recover
your Almond password. Not you? You can safely ignore this email.
`
    };

    return SendMail.send(mailOptions);
}

router.post('/recovery/start', (req, res, next) => {
    db.withClient(async (dbClient) => {
        const users = await model.getByName(dbClient, req.body.username);

        if (users.length === 0) {
            // the username was not valid
            // pretend that we sent an email, even though we did not
            // this eliminates the ability to check for the existance of
            // a username by initiating password recovery
            res.render('message', {
                page_title: req._("Almond - Password Reset Sent"),
                message: req._("A recovery email was sent to the address on file for %s. If you did not receive it, please check the spelling of your username, and check your Spam folder.").format(req.body.username)
            });
            return;
        }

        if (!users[0].email_verified) {
            res.render('error', {
                page_title: req._("Almond - Error"),
                message: req._("You did not verify your email address, hence you cannot recover your password automatically. Please contact the website adminstrators to recover your password.")
            });
            return;
        }

        // note: we must not reveal the email address in this message
        await sendRecoveryEmail(users[0].cloud_id, users[0].username, users[0].email);
        res.render('message', {
            page_title: req._("Almond - Password Reset Sent"),
            message: req._("A recovery email was sent to the address on file for %s. If you did not receive it, please check the spelling of your username, and check your Spam folder.").format(req.body.username)
        });
    }).catch(next);
});

router.get('/recovery/continue/:token', (req, res, next) => {
    db.withClient(async (dbClient) => {
        const decoded = await util.promisify(jwt.verify)(req.params.token, secret.getJWTSigningKey(), {
            algorithms: ['HS256'],
            audience: 'pw-recovery',
        });
        const users = await model.getByCloudId(dbClient, decoded.sub);
        if (users.length === 0) {
            res.status(404).render('error', {
                page_title: req._("Almond - Error"),
                message: req._("The user for which you're resetting the password no longer exists.")
            });
            return;
        }

        res.render('password_recovery_continue', {
            page_title: req._("Almond - Password Reset"),
            token: req.params.token,
            recoveryUser: users[0],
            error: undefined
        });
    }, (err) => {
        res.status(400).render('error', {
            page_title: req._("Almond - Password Reset"),
            message: req._("The verification link you have clicked is not valid.")
        });
    }).catch(next);
});

router.post('/recovery/continue', (req, res, next) => {
    db.withTransaction(async (dbClient) => {
        let decoded;
        try {
            decoded = await util.promisify(jwt.verify)(req.body.token, secret.getJWTSigningKey(), {
                algorithms: ['HS256'],
                audience: 'pw-recovery',
            });
        } catch(e) {
            res.status(400).render('error', {
                page_title: req._("Almond - Error"),
                message: e
            });
            return;
        }
        try {
            if (typeof req.body['password'] !== 'string' ||
                req.body['password'].length < 8 ||
                req.body['password'].length > 255)
                throw new Error(req._("You must specifiy a valid password (of at least 8 characters)"));

            if (req.body['confirm-password'] !== req.body['password'])
                throw new Error(req._("The password and the confirmation do not match"));
        } catch(e) {
            res.render('password_recovery_continue', {
                page_title: req._("Almond - Password Reset"),
                token: req.body.token,
                error: e
            });
        }

        const users = await model.getByCloudId(dbClient, decoded.sub);
        if (users.length === 0) {
            res.status(404).render('error', {
                page_title: req._("Almond - Error"),
                message: req._("The user for which you're resetting the password no longer exists.")
            });
            return;
        }

        if (user.totp_key !== null) {
            const rv = totp.verify(req.body.code, secret.decrypt(user.totp_key), { window: 6, time: TOTP_PERIOD });
            if (!rv) {
                res.render('password_recovery_continue', {
                    page_title: req._("Almond - Password Reset"),
                    token: req.body.token,
                    error: req._("Invalid OTP code")
                });
                return;
            }
        }

        const user = users[0];
        await userUtils.resetPassword(dbClient, user, req.body.password);
        await login(req, user);
        await model.recordLogin(dbClient, user.id);

        // we have completed 2fa above
        req.session.completed2fa = true;
        res.locals.authenticated = true;
        res.locals.user = user;
        res.render('message', {
            page_title: req._("Almond - Password Reset"),
            message: req._("Your password was reset successfully.")
        });
    }).catch(next);
});


async function getProfile(req, res, pw_error, profile_error) {
    const oauth_permissions = await db.withClient((dbClient) => {
        return oauthModel.getAllPermissionsOfUser(dbClient, req.user.cloud_id);
    });

    res.render('user_profile', { page_title: req._("Thingpedia - User Profile"),
                                 csrfToken: req.csrfToken(),
                                 pw_error,
                                 profile_error,
                                 oauth_permissions });
}

router.get('/profile', userUtils.requireLogIn, (req, res, next) => {
    getProfile(req, res, undefined, undefined).catch(next);
});

router.post('/profile', userUtils.requireLogIn, (req, res, next) => {
    return db.withTransaction(async (dbClient) => {
        if (typeof req.body.username !== 'string' ||
            req.body.username.length === 0 ||
            req.body.username.length > 255)
            req.body.username = req.user.username;
        if (typeof req.body['email'] !== 'string' ||
            req.body['email'].length === 0 ||
            req.body['email'].indexOf('@') < 0 ||
            req.body['email'].length > 255)
            req.body.email = req.user.email;

        let profile_flags = 0;
        if (req.body.visible_organization_profile)
            profile_flags |= userUtils.ProfileFlags.VISIBLE_ORGANIZATION_PROFILE;
        if (req.body.show_human_name)
            profile_flags |= userUtils.ProfileFlags.SHOW_HUMAN_NAME;
        if (req.body.show_profile_picture)
            profile_flags |= userUtils.ProfileFlags.SHOW_PROFILE_PICTURE;

        const mustSendEmail = req.body.email !== req.user.email;

        await model.update(dbClient, req.user.id,
                            { username: req.body.username,
                              email: req.body.email,
                              email_verified: !mustSendEmail,
                              human_name: req.body.human_name,
                              profile_flags });
        req.user.username = req.body.username;
        req.user.email = req.body.email;
        req.user.human_name = req.body.human_name;
        req.user.profile_flags = profile_flags;
        if (mustSendEmail)
            await sendValidationEmail(req.user.cloud_id, req.body.username, req.body.email);

        return getProfile(req, res, undefined,
            mustSendEmail ?
            req._("A verification email was sent to your new email address. Account functionality will be limited until you verify your new address.")
            : undefined);
    }).catch((error) => {
        return getProfile(req, res, undefined, error);
    }).catch(next);
});

router.post('/revoke-oauth2', userUtils.requireLogIn, (req, res, next) => {
    return db.withTransaction((dbClient) => {
        return oauthModel.revokePermission(dbClient, req.body.client_id, req.user.cloud_id);
    }).then(() => {
            res.redirect(303, '/user/profile');
    }).catch(next);
});

router.post('/change-password', userUtils.requireLogIn, (req, res, next) => {
    var password, oldpassword;
    Promise.resolve().then(() => {
        if (typeof req.body['password'] !== 'string' ||
            req.body['password'].length < 8 ||
            req.body['password'].length > 255)
            throw new Error(req._("You must specifiy a valid password (of at least 8 characters)"));

        if (req.body['confirm-password'] !== req.body['password'])
            throw new Error(req._("The password and the confirmation do not match"));
        password = req.body['password'];

        if (req.user.password) {
            if (typeof req.body['old_password'] !== 'string')
                throw new Error(req._("You must specifiy your old password"));
            oldpassword = req.body['old_password'];
        }

        return db.withTransaction((dbClient) => {
            return userUtils.update(dbClient, req.user, oldpassword, password);
        }).then(() => {
            res.redirect(303, '/user/profile');
        });
    }).catch((e) => {
        return getProfile(req, res, e, undefined);
    }).catch(next);
});

router.post('/delete', userUtils.requireLogIn, (req, res, next) => {
    db.withTransaction(async (dbClient) => {
        await model.delete(dbClient, req.user.id);
    }).then(() => {
        req.logout();
        res.redirect(303, '/');
    }).catch(next);
});

module.exports = router;
