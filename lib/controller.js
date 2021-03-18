'use strict';
const async = require('async');
const bcrypt = require('bcryptjs');
const querystring = require('querystring');
const uuid = require('uuid');

const hookService = require('./hooks');
const createService = require('./service');
const helpers = require('./helpers');

const EXPIRY_MARGIN = 5 * 60 * 1000;
module.exports = function createController(config) {
  const service = createService(config);

  function createLoginUrl(host, serviceName, key, options) {
    const serviceProvider = config.serviceProviders[serviceName] || {};
    const query = {
      client_id: config.auth.clientId,
      redirect_uri: serviceProvider.redirectUri || `${host}${config.basePath}/login/callback`,
      state: key,
      scope: serviceProvider.scopes,
      service: serviceProvider.identifier,
      save_consent: true,
      response_type: 'code',
    }

    if (options.auth_type) {
      query.auth_type = options.auth_type;
    } else if(serviceProvider.authenticationType) {
      query.auth_type = serviceProvider.authenticationType;
    }

    if(options.lng) {
      query.lng = options.lng;
    }

    if (serviceProvider.version === 'v2') {
      delete query.service;
      query.auth_methods = options.auth_methods || serviceProvider.authMethods;
      query.minimal_assurance_level= serviceProvider.minimalAssuranceLevel;
    }

    Object.keys(query).forEach(key => {
      if (!query[key]) {
        delete query[key];
      }
    });

    const authPath = (serviceProvider.version === 'v2') ? '/v2/authorize' : '/v1/authorize';

    return `${config.oauthHost}${authPath}?${querystring.stringify(query)}`;
  }

  function createLogoutUrl(serviceName, options) {
    const serviceProvider = config.serviceProviders[serviceName] || {};
    const data = JSON.stringify({
      user_id: options.userId,
      access_token: options.token,
      redirect_uri: options.redirectUri
    });

    const query = {
      client_id: config.auth.clientId,
      service: config.serviceProviders[serviceName].identifier,
      data: helpers.encrypt(data, config.auth.clientSecret),
    };

    if(serviceProvider.authenticationType) {
      query.auth_type = serviceProvider.authenticationType;
    }

    let logoutUrl = `${config.oauthHost}/v1/logout/redirect/encrypted?${querystring.stringify(query)}`;

    if (serviceProvider.version === 'v2') {
      logoutUrl = `${config.oauthHost}/v2/logout/redirect/encrypted?${querystring.stringify(query)}`;
    }

    return logoutUrl;
  }

  function login(req, res) {
    const serviceName = req.params.service;
    const serviceProvider = config.serviceProviders[serviceName];

    if (!serviceProvider) {
      return res.sendStatus(404);
    }

    const host = helpers.getHost(req);
    const key = `${serviceName}_${uuid.v4()}`;
    const url = createLoginUrl(host, serviceName, key, req.query);
    req.session[`${serviceName}_key`] = key;
    req.session.fromUrl = req.query.fromUrl || '/';

    const configuredHooks = serviceProvider.hooks || {};

    hookService.runHooks(configuredHooks.preLogin, req, res, () => {
      return req.session.save(() => res.redirect(url));
    });
  }

  function isLoggedinInService(req, res) {
    const serviceName = req.params.service;
    const key = config.serviceProviders[serviceName].key || 'user';
    const user = req.session[key];
    if (user) {
      return res.json({
        isLoggedin: true,
        [key]: user
      });
    }

    return res.json({
      isLoggedin: false,
    });
  }

  function isLoggedin(req, res) {
    const users = {};

    Object.keys(config.serviceProviders).forEach(serviceProviderKey => {
      const userKey = config.serviceProviders[serviceProviderKey].key || 'user';
      if(req.session[userKey]) {
        users[userKey] = req.session[userKey];
      }
    });

    if(Object.keys(users).length === 0) {
      return res.json({
        isLoggedin: false
      });
    }
      return res.json(Object.assign({
        isLoggedin: true,
      }, users));
  }

  function callback(req, res) {
    if (!req.query.code || !req.query.state) {
      return res.redirect(config.errorRedirect);
    }

    const state = req.query.state;
    const serviceName = state.split('_')[0];

    if (!config.serviceProviders[serviceName]) {
      return res.sendStatus(404);
    }

    if (req.query.state !== req.session[`${serviceName}_key`]) {
      let loginUrl = `${config.basePath}/login/${serviceName}`;
      const fromUrl = req.session.fromUrl;
      if (fromUrl) {
        loginUrl = `${loginUrl}?fromUrl=${fromUrl}`;
      }
      return res.redirect(loginUrl);
    }

    delete req.session[`${serviceName}_key`];
    let hooks = [];
    const configuredHooks = config.serviceProviders[serviceName].hooks;
    if (configuredHooks && Array.isArray(configuredHooks.loginSuccess)) {
      hooks = configuredHooks.loginSuccess.map(hook => {
        return (next) => hook(req, res, next);
      });
    }

    service.loginUser(req.query.code, serviceName, (err, user, token) => {
      if (err) {
        console.log('error tijdens login', err);
        return res.redirect(config.errorRedirect);
      }

      const sessionKey = config.serviceProviders[serviceName].key || 'user';
      user.serviceType = serviceName;
      req.session[sessionKey] = user;
      req.session[`${sessionKey}Token`] = token;

      async.series(hooks, (error) => {
        if (error) {
          console.log(error);
          return res.redirect(config.errorRedirect);
        }
        req.session.save(() => res.redirect(req.session.fromUrl || '/'));
      });
    });
  }

  function logoutCallback(req, res) {
    const serviceName = req.params.service;

    if(!config.serviceProviders[serviceName]) {
      return res.sendStatus(404);
    }

    let hooks = [];
    const configuredHooks = config.serviceProviders[serviceName].hooks;
    if (configuredHooks && Array.isArray(configuredHooks.logoutSuccess)) {
      hooks = configuredHooks.logoutSuccess.map(hook => {
        return (next) => hook(req, res, next);
      });
    }

    const key = config.serviceProviders[serviceName].key || 'user';

    async.series(hooks, () => {
      delete req.session[key];
      delete req.session[`${key}Token`];
      delete req.session[`${serviceName}_logoutKey`];
      const tempSession = req.session;
      req.session.regenerate(() =>  {
        Object.assign(req.session, tempSession);
        req.session.save(() => res.redirect(tempSession.logoutFromUrl || '/'));
      });
    });
  }

  function logout(req, res) {
    const serviceName = req.params.service;
    if (!config.serviceProviders[serviceName]) {
      return res.sendStatus(404);
    }

    const serviceProvider = config.serviceProviders[serviceName];
    const key = serviceProvider.key || 'user';
    const token = req.session[`${key}Token`];
    const authenticationType = serviceProvider.authenticationType;
    if(!req.session[key]) {
      return res.redirect('/');
    }

    req.session.logoutFromUrl = req.query.fromUrl || req.query.fromurl || '/';
    const state = uuid.v4();
    req.session[`${serviceName}_logoutKey`] = state;

    const logoutParams = {
      redirectUri: `${helpers.getHost(req)}${config.basePath || '/auth'}/logout/callback/${serviceName}?state=${state}`,
      token: token.accessToken,
      userId: req.session[key].id,
      authenticationType
    };

    if (serviceProvider.version === 'v2' && !req.session[key].id) {
      logoutParams.userId = req.session[key].profile.id;
    }

    const logoutUrl = createLogoutUrl(serviceName, logoutParams);
    const configuredHooks = serviceProvider.hooks || {};

    hookService.runHooks(configuredHooks.preLogout, req, res, () => {
      req.session.save(() => res.redirect(logoutUrl));
    });
  }

  function refresh(req, res, next) {
    let tokenKeys = []
    const tokensRefreshFunctions = {};
    Object.keys(config.serviceProviders).map(serviceProviderKey => {
      const serviceProviderConfig = config.serviceProviders[serviceProviderKey];

      if(!serviceProviderConfig.refresh) {
        return;
      }
      const tokenKey = `${serviceProviderConfig.key || 'user'}Token`;
      const token = req.session[tokenKey];
      if(tokenKeys.indexOf(tokenKey) === -1 && token) {
        tokenKeys.push(tokenKey);
        if(shouldRefreshToken(token, serviceProviderConfig)){
          tokensRefreshFunctions[tokenKey] = cb => service.refresh(token, serviceProviderKey, cb);
        }
      }
    });

    if(Object.keys(tokensRefreshFunctions).length === 0) {
      return next();
    }

    async.parallel(tokensRefreshFunctions, (err, result) => {
      if(err) {
        return next();
      }

      req.session = Object.assign(req.session, result);
      req.session.save(() => next());
    });
  }

  function shouldRefreshToken(token, serviceProviderConfig) {
    return (!token.issuedDate || !serviceProviderConfig.refreshMax || new Date(token.issuedDate).getTime() + (serviceProviderConfig.refreshMax * 1000) > new Date().getTime())
        && (new Date(token.expiresIn) <= new Date(Date.now() + EXPIRY_MARGIN));
  }

  function loggedout(req, res, next) {
    const {
      headerKey = 'x-logout-token',
      securityHash = '',
      sessionStoreLogoutAdapter: adapter = false
    } = config.logout || {};

    const serviceProvider = config.serviceProviders[req.params.service] || false;
    const token = req.get(headerKey) || '';

    if (!serviceProvider) {
      return res.sendStatus(404);
    }

    if (!adapter) {
      return res.sendStatus(200);
    }
    if (!bcrypt.compareSync(token, securityHash)) {
      return res.sendStatus(401);
    }

    const sessionKey = serviceProvider.key || 'user';
    const accessTokenKey = `${sessionKey}Token`;
    adapter(sessionKey, accessTokenKey, req.body)
      .then(() => res.sendStatus(200))
      .catch((err) => res.status(500).json(err));
  }

  return {
    login,
    logout,
    logoutCallback,
    isLoggedinInService,
    isLoggedin,
    callback,
    refresh,
    loggedout
  }

}
