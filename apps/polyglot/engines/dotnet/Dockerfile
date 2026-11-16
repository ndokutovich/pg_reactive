FROM mcr.microsoft.com/dotnet/sdk:10.0.404 AS build
WORKDIR /src
COPY engine.csproj ./
RUN dotnet restore
COPY . ./
RUN dotnet publish -c Release -o /out --self-contained false /p:PublishSingleFile=false

FROM mcr.microsoft.com/dotnet/runtime:10.0.15
WORKDIR /app
COPY --from=build /out ./
USER app
ENTRYPOINT ["dotnet", "engine.dll"]
