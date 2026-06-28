/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");
const { getHttpsServerOptions } = require("office-addin-webpack-https");

module.exports = async (_env, options) => {
  const isDev = options.mode !== "production";

  /** @type {import('webpack-dev-server').Configuration} */
  const devServerConfig = {
    port: 3000,
    hot: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
    static: [
      {
        directory: path.join(__dirname, "assets"),
        publicPath: "/assets",
      },
    ],
  };

  if (isDev) {
    const httpsOptions = await getHttpsServerOptions();
    devServerConfig.server = { type: "https", options: httpsOptions };
  }

  /** @type {import('webpack').Configuration} */
  const config = {
    devtool: "source-map",
    entry: {
      taskpane: "./src/taskpane/index.tsx",
      commands: "./src/commands/commands.ts",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].js",
      clean: true,
    },
    resolve: {
      extensions: [".ts", ".tsx", ".js", ".jsx"],
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          use: "ts-loader",
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ["style-loader", "css-loader"],
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/index.html",
        chunks: ["taskpane"],
      }),
      new HtmlWebpackPlugin({
        filename: "commands.html",
        template: "./src/commands/commands.html",
        chunks: ["commands"],
      }),
      // Expose env vars to the bundle so TypeScript process.env calls compile
      new webpack.EnvironmentPlugin({
        REACT_APP_API_BASE_URL: "http://localhost:3001",
        REACT_APP_SUPABASE_URL: "",
        REACT_APP_SUPABASE_ANON_KEY: "",
        NODE_ENV: isDev ? "development" : "production",
      }),
    ],
    devServer: devServerConfig,
  };

  return config;
};
